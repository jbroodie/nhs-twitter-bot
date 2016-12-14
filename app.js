var Twitter = require('twitter');
var env = require('dotenv').config();
var async = require('async');
var request = require('request');
var postcodesIO = require('postcodesio-client');
var log4js = require( "log4js" );


// log some output - this needs changing to Bunyan!
function log(logString){
    console.log(logString);
    logger.debug(logString);

}

// Does the source tweeter follow us?
function checkIfFollower(data, reqField) {
    
    var connectionField = data[0].connections[0];

    if (connectionField == "followed_by"){   // connections = 'followed by'' for a follower
        log("checkIfFollower connection field value = " + connectionField + ". Returning TRUE");
        return true;
    }

    return false;
}

// parse the tweet string for a postcode
function getTweetPostcode(tweetString){
    var postcodeRegEx = "^([Gg][Ii][Rr] 0[Aa]{2})|((([A-Za-z][0-9]{1,2})|(([A-Za-z][A-Ha-hJ-Yj-y][0-9]{1,2})|(([A-Za-z]0-9][A-Za-z])|([A-Z-z][A-Ha-hJ-Yj-y][09]?[A-Za-z])))) {0,1}[0-9][A-Za-z]{2})";
    var match = tweetString.match(postcodeRegEx);

    var tweetPostcode = null;
    if(match != null){
        tweetPostcode = match[0];// just assume the first postcode in the array is the one we need
    }
    log("getTweetPostcode: Match[0] is " + tweetPostcode);

    return tweetPostcode;
}

// call to the API to convert postcode to lat/lon
function getLongLatFromPostcode(postCode, callback)
{
    var longLatValue = {};
    var postcodesAPI = new postcodesIO();
    postcodesAPI.lookup(postCode, function (error, longLatValue) {
        if(error){
            log("getLongLatFromPostcode - postcodesAPI error = " + error);
            return callback(error);
        }

        callback(null, longLatValue);
    });
}

// using long and lat, look up the nearest pharmacy
function getNearestPharmFromLongLat(geoLocation, callback){

    var serviceReply = {};

    var requestUrl = env.nearby_service_api + "latitude=" + geoLocation.latitude + "&" + "longitude=" + geoLocation.longitude;
    request(requestUrl, function (error, response, body) {
        if(error){
            log(error);
            return callback(error);
        }

        if (response.statusCode != 200) {
            return callback(new Error("getNearestPharmFromLogLat = url did not return 200"));
        }
        
        // convert the nearest response into a reply
       serviceReply.serviceLocResolved = true;

        var responseStuff = JSON.parse(body);
        var firstNearbyPharm = responseStuff.nearby[0];
        var nearbyName = firstNearbyPharm.name;
        var nearbyMessage = firstNearbyPharm.openingTimesMessage;
        var address = firstNearbyPharm.address;
        // if fields are null, then don't add them to the location info
        var add1 = (address.line1=="" ? "": (address.line1 + ", "));
        var add2 = (address.line2=="" ? "": (address.line2 + ", "));
        var add3 = (address.line3=="" ? "": (address.line3 + ", "));
        var add4 = (address.city=="" ? "": (address.city + ", "));
        var postcode = (address.postcode=="" ? "": address.postcode);

        serviceReply.text = "Your nearest Pharmacy is " + nearbyName + ". "
            + add1 + add2 + add3 + add4 + postcode + ". " + nearbyMessage;
        log("Data from nearest to return is " + serviceReply.text);
    
        callback(null, serviceReply);
    });
}

function createStatusUpdateObj(screen_name, currentTweetText, tweetInfo)
{
    var StatusObj = {};
    var date = new Date();
    var uniqueRef = " [Ref:" + date.getTime() + "]";
    
    if(tweetInfo.isFollower == true){
        if(tweetInfo.serviceLocResolved){
            statusObj = {status: "D " + screen_name + " " + currentTweetText };
        }else{
            if(tweetInfo.badPostcode == true){
                statusObj = {status: "D " + screen_name + " Thanks for the tweet about nearest Pharmacy. Sorry, could not find a postcode that matches the one you sent. Please check and try again"};
            }else{
                statusObj = {status: "D " + screen_name + " Thanks for the tweet about nearest Pharmacy. I need a bit more info on your location. Tweet me your postcode or turn on tweet location in your profile. Thanks "};
            }
        }
    }
    else{
        statusObj = {status: "@" + screen_name + ". I'm a bot. For best results, follow me & tweet me in form 'Nearest Pharmacy <your postcode> and I'll DM a reply"};
    }
    statusObj.status += uniqueRef;

    return statusObj;
}

// respondToNearestPharm query
function respondToNearestPharm(client, tweet) {
    var tweetInfo = {
        badPostcode: true,
        isFollower: false,
        geoLoc: null,
        postcodeResolved: false,
        longlatResolved: false,
        serviceLocResolved: false
    };
    var tweetReply = {
        text: ""
    };

    var geoLocation = {
        longitude: null,
        latitude: null
    };


    var statusObj = {screen_name: tweet.user.screen_name};

    async.series([
        //Check if user is a follower first
        function(callback) {
            //see if the user follows us
            client.get('friendships/lookup', statusObj, function (error, tweetReply, response){
                if (error){
                    return callback(error);
                }
                //Check that a user was found
                if(tweetReply != null){
                    tweetInfo.isFollower = checkIfFollower(tweetReply);
                    log("checkFriendshipResponse returned " + tweetInfo.isFollower);
                }
                callback();
            });
        },
        //Now find out location (won't be called before we've found if they are a follower - although this could be in parallel in reality)
        function(callback) {
            var userGeoEnabled = tweet.user.geo_enabled;
            tweetInfo.geoLoc = tweet.user.location;
    
            if(tweetInfo.isFollower == false){
                // no point in doing lookups if they dont' follow us
                callback();
            } else if(tweetInfo.geoLoc != null){
                // Not tested this bit but if get here, then have got a geo-enabled tweet. By default, this not turned on on twitter accounts
                log("User has geo-enabled tweets. Location provided is " + tweetInfo.geoLoc)
                geoLocation.longitude = tweetInfo.geoLoc.longitude;
                geoLocation.latitude = tweetInfo.geoLoc.latitude;
                tweetInfo.longlatResolved = true;
                callback();
            } else{
                // if no geolocation in the tweet data parse the tweet text for a postcode
                var tweetPostcode = getTweetPostcode(tweet.text);
                if(tweetPostcode !=null){
                    tweetInfo.postcodeResolved = true;
                    var longLatInfo = {};
                    getLongLatFromPostcode(tweetPostcode, function(error, longLatInfo){
                        if(error) return callback(error);
            
                        if(longLatInfo!=null){    
                            tweetInfo.longlatResolved = true;
                            geoLocation.latitude = longLatInfo.latitude;
                            geoLocation.longitude = longLatInfo.longitude;
                        }
                        callback();
                    });
                }else callback();
            }
        },
        //Return info from the nearest look up
        function(callback) {
            if(tweetInfo.isFollower == false){
                // no point in doing lookups if they dont' follow us
                callback();
                return;
            }
            
            if(tweetInfo.longlatResolved == true) { 
                // Now have the lat/long, so use this to look up the nearest service   
                getNearestPharmFromLongLat(geoLocation, function(error, serviceResult){
                    if(error) return callback(error);

                    tweetReply.text = serviceResult.text;
                    tweetInfo.serviceLocResolved = serviceResult.serviceLocResolved;
                    callback();
                });
            }else callback();
        },
        ], function(error) { //This function gets called after the above tasks have called their "task callbacks"
            if (error) return next(error);
            
            // based on what has been found out, prepare a response object
            var statusObj = createStatusUpdateObj(tweet.user.screen_name, tweetReply.text, tweetInfo);

            //call the post function to tweet something
            log("About to tweet reply using: " + statusObj.status);
            client.post('statuses/update', statusObj,  function (error, tweetReply, response){
                if (error){ 
                    log("Error at end of respondToNearestPharm: " + error)
                    //return callback(error);
                }
            });
        });
}

function replyWithHelp(client, screenName) {

}

function respondToCondition(client, screenName) {
    // TODO
}


function onTweet(tweet) {
    // print out the text of the tweet that came in
    log("onTweet: Just received this tweet: " + tweet.text + " from " + tweet.user.screen_name);
    
    var tweetTextLC = tweet.text.toLowerCase();

    // for now, just focus on nearest pharmacy
    respondToNearestPharm(client, tweet);
/*
    // work out what has been tweeted
    if(tweetTextLC.indexOf("I'm a bot. For best results follow me & tweet me in the form:") > -1){
        //ignore - this is us consuming our own tweet
    }
    else if(tweetTextLC.indexOf("help") > -1){
        // tweet is a help one
        //replyWithHelp(client, tweet.user.screen_name);
    }
    else if (tweetTextLC.indexOf("nearest pharmacy") > -1){
        // tweet seeking nearest pharmacy
        respondToNearestPharm(client, tweet);
    }
    else if (tweetTextLC.indexOf("what is") > -1){
        // tweet seeking info on a condition
        //respondToCondition(client, tweet.user.screen_name);
    }
    else{
        // don't understand, so just send a generic reply (currently same as help)
        //replyWithHelp(client, tweet.user.screen_name);
    }
    */
  }

function streamTweet (stream) {
    // callBack for when we get tweet data...
    stream.on('data', onTweet);

    // ... when we get an error...
    stream.on('error', function(error) {
        log("function streamTweet error:" + error);
    });
}

//=========== end of functions ============================
var secret = {
    consumer_key: env.consumer_key, 
    consumer_secret: env.consumer_secret, 
    access_token_key: env.access_token, 
    access_token_secret: env.access_token_secret   
};
var client = new Twitter(secret);


log4js.loadAppender('file');

log4js.configure({
    appenders: [
        {
            type:'file',
            filename: 'twitbot.log',
            category: 'debug',
            maxLogSize: 20480,
            backups: 10
        }
    ]
})
var logger = log4js.getLogger('debug');

log("Started running...");

var replyCount = 0;

// set things going
var trackAndFollowObj= {
    //track: 'help,nearest pharmacy,what is'
    //follow: 'AndyDevTest'
    //'follow=AndyDevTest'
    //{track: 'help,nearest pharmacy,what is'},
    //{follow: '799761379150495744'}
    //track: 'help,nearest pharmacy,what is',
    //follow: '799761379150495744'
    follow: env.this_account_id
}; 

//var result = getTweetPostcode("nearest pharmacy S42 6RP and something else")
client.stream('statuses/filter', trackAndFollowObj, streamTweet);

