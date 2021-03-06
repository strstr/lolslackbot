var SlackBot = require('slackbots');
var request = require('request');
var jsonfile = require('jsonfile')
var util = require('util')

var SLACKBOT_API_KEY = process.env.SLACKBOT_API_KEY;

// create a bot
var bot = new SlackBot({
    token: SLACKBOT_API_KEY,
    name: 'LOLtacle' // todo: load from env or config
});

var RIOT_API_KEY = process.env.RIOT_API_KEY;
var RIOT_API_ROOT_URL = 'https://na.api.pvp.net/';

///////////////////////
// riot api wrap
function makeCallURL(apicall, params) {
    var parametrizedCall = apicall;
    for (paramName in params) {
        parametrizedCall = parametrizedCall.replace('{' + paramName + '}', params[paramName]);
    }

    return RIOT_API_ROOT_URL + parametrizedCall + '?api_key=' + RIOT_API_KEY;
}

var SummonerByName = {
    url: 'api/lol/na/v1.4/summoner/by-name/{summonername}',
    parser: function (body) {
        players = JSON.parse(body);
        for (player in players) {
            return players[player];
        }
    }
}

var CurrentGame = {
    url: 'observer-mode/rest/consumer/getSpectatorGameInfo/NA1/{summonerId}',
    parser: function (body) {
        return JSON.parse(body);
    }
}

var LastGames = {
    url: '/api/lol/na/v1.3/game/by-summoner/{summonerId}/recent',
    parser: function (body) {
        return JSON.parse(body).games;
    }
}

var ChampionNameById = {
    url: '/api/lol/static-data/na/v1.2/champion/{id}',
    parser: function (body) {
        return JSON.parse(body).name;
    }
}

var workqueue = [];

var workdebugout = function (msg) {
    //console.log(msg);
}

var working = false;
var currentjob;
var pumpqueue = function () {

    workdebugout("queue has " + workqueue.length + " entries");

    if (workqueue.length && !currentjob) {
        currentjob = workqueue[0];
        workqueue.splice(0, 1);
        workdebugout("doing work for job " + currentjob.index);
        currentjob.run();
        workdebugout("running work for " + currentjob.index);
    }

    if (currentjob && currentjob.responded) {
        workdebugout("finished handling response for " + currentjob.index);
        currentjob = null;
    }
}

var workdelay = 2000;
setInterval(pumpqueue, workdelay);

var jobcounter = 0;
var doRequest = function (call, params, payloadFun, errorFun) {
    workdebugout("queueing " + makeCallURL(call.url, params));

    var job = {};
    job.index = jobcounter++;
    job.run = function () {
        var c = makeCallURL(call.url, params);
        workdebugout("requesting " + c);
        request(c,
            function (err, response, body) {
                if (err || response.statusCode != 200) {
                    if (err && response && response.statusCode == 429) {
                        console.log("too many requests");
                    }

                    workdebugout("error " + (response ? response.statusCode : "no response"));

                    var statuscode = response ? response.statusCode : 0;
                    if (statuscode == 401) {
                        console.log("key error for RIOT API");
                    }

                    if (errorFun)
                        errorFun(err, statuscode);
                    job.responded = true;
                    return;
                }

                workdebugout("running " + c);
                payloadFun(call.parser(body));
                job.responded = true;
            }
        );
    };

    job.url = makeCallURL(call.url, params);

    workqueue.push(job);
}

///////////////////////
// slackbot api wrap

announceparams = {
    icon_url: 'https://avatars.slack-edge.com/2016-04-17/35396496742_2e722be390b0de1bd9cc_48.png'
};

var announce = function (msg) {
    console.log(msg);

    bot.postMessageToChannel('leagueoflegends', msg, announceparams);
}

// lolbot api

var summonersfile = 'summoners.json';

// should be loaded from persistence
var summoners = [];

var findSummonerByName = function (summonername) {
    for (s in summoners) {
        if (summoners[s].name.toLowerCase() === summonername.toLowerCase()) {
            return summoners[s];
        }
    }
}

var addSummoner = function (summoner) {
    summoners.push(summoner);
    SaveSummoners();
}

var removeSummonerByName = function (summonername) {
    var toRemove = -1;
    for (s in summoners) {
        if (summoners[s].name.toLowerCase() === summonername.toLowerCase()) {
            toRemove = s;
        }
    }

    summoners.splice(toRemove, 1);
    SaveSummoners();
}

var SaveSummoners = function () {
    jsonfile.writeFileSync(summonersfile, summoners);
}

var LoadSummoners = function (then) {
    summoners = jsonfile.readFileSync(summonersfile);

    var invalidSummoners = [];

    var donecount = 0;

    var didnothing = true;
    // refresh id's
    for (s in summoners) {
        if (!summoners[s].id) {
            didnothing = false;

            (function (summoner) {
                doRequest(SummonerByName, {
                        summonername: summoner.name
                    },
                    function (summoneronserver) {
                        summoner.id = summoneronserver.id;

                        SaveSummoners();

                        // the horror
                        donecount++;
                        if (then && donecount == summoners.length) {
                            then();
                        }
                    },
                    function (error, response) {
                        invalidSummoners.push(summoner);

                        // THE HORROR
                        donecount++;
                        if (then && donecount == summoners.length) {
                            then();
                        }
                    }
                );
            })(summoners[s]);
        }
    }

    if (didnothing) {
        then();
    }

    // todo : reconcile or remove invalidSummoners
}

var ObserveSummoner = function (summonername, then) {
    if (findSummonerByName(summonername)) {
        announce(summonername + " is already under observation");

        if (then)
            then();
    } else {
        doRequest(SummonerByName, {
                summonername: summonername
            },
            function (summoner) {
                var newSummoner = {
                    name: summoner.name,
                    id: summoner.id,
                    currentGame: null
                };

                announce("now observing " + summoner.name);

                doRequest(CurrentGame, {
                        summonerId: summoner.id
                    },
                    function (game) {
                        if (!summoner.currentGame || summoner.currentGame.gameId != game.gameId) {
                            announce(summoner.name + " is currently in a game");
                            summoner.currentGame = game;
                        }

                        addSummoner(newSummoner);
                    },
                    function (error, response) {
                        if (response === 404) {
                            // wasn't playing...
                        }

                        addSummoner(newSummoner);
                        console.log("error?" + summoner.id + " " + response);
                    }
                );

                if (then)
                    then();
            },
            function (error, response) {
                announce("unknown summoner " + summonername);

                if (then)
                    then();
            }
        );
    }
}

var DontObserveSummoner = function (summonername, then) {
    if (!findSummonerByName(summonername)) {
        announce(summonername + " is already not under observation");

        if (then)
            then();
    } else {
        removeSummonerByName(summonername);

        announce("not observing " + summonername + " anymore");

        if (then)
            then();
    }
}

var AnnounceCurrentGameStart = function (summoner) {
    if (summoner.gamestartsannounced && summoner.gamestartsannounced.indexOf(summoner.currentGame.gameId) != -1) {
        // already announced
        return;
    }
    if (!summoner.gamestartsannounced) {
        summoner.gamestartsannounced = [];
    }

    var champId;
    for (p in summoner.currentGame.participants) {
        if (summoner.currentGame.participants[p].summonerId == summoner.id) {
            champId = summoner.currentGame.participants[p].championId;
        }
    }

    summoner.gamestartsannounced.push(summoner.currentGame.gameId);
    SaveSummoners();

    doRequest(ChampionNameById, {
            id: champId
        },
        function (champname) {
            summoner.lastchamp = champname;
            announce(summoner.name + " has just started game on " + Maps[summoner.currentGame.mapId] + " (" + summoner.currentGame.gameMode + ")" + " playing " + summoner.lastchamp);
        });
}

function twodigits(n) {
    return n > 9 ? "" + n : "0" + n;
}

function FormatGameTime(seconds) {
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return twodigits(m) + ':' + twodigits(s);
}

var Maps = {};
Maps[8] = "Crystal Scar";
Maps[10] = "Twisted Treeline";
Maps[11] = "Summoner's Rift";
Maps[12] = "Howling Abyss"

var AnnounceGameEnd = function (summoner, game) {
    var result = game.stats.win ? "won " : "lost ";
    var formattedgame = "on " + Maps[game.mapId] + " (" + game.gameMode + ")";

    var numDeaths = game.stats.numDeaths ? game.stats.numDeaths : "0";
    var championsKilled = game.stats.championsKilled ? game.stats.championsKilled : "0";
    var assists = game.stats.assists ? game.stats.assists : "0";
    var score = championsKilled + "/" + numDeaths + "/" + assists;

    announce(summoner.name + " as " + summoner.lastchamp + " just scored " + score + " and " + result + formattedgame + " in " + FormatGameTime(game.stats.timePlayed) + " minutes");
}

var UpdateGameStates = function () {
    if (workqueue.length)
        return;

    for (s in summoners) {
        (function (summoner) {
            if (summoner.currentGame && !summoner.waitingforresult) {
                doRequest(CurrentGame, {
                        summonerId: summoner.id
                    },
                    function (game) {
                        // still playing
                        summoner.currentGame = game;
                    },
                    function (error, response) {
                        if (response === 404) {
                            // game ended
                            summoner.waitingforresult = true;
                        }
                    }
                )
            } else if (summoner.currentGame && summoner.waitingforresult) {
                doRequest(LastGames, {
                        summonerId: summoner.id
                    },
                    function (games) {
                        for (game in games) {
                            if (summoner.currentGame && games[game].gameId == summoner.currentGame.gameId) {
                                AnnounceGameEnd(summoner, games[game]);
                                summoner.waitingforresult = false;
                                summoner.currentGame = null;
                                SaveSummoners();
                            }
                        }
                    }
                )
            } else {
                doRequest(CurrentGame, {
                        summonerId: summoner.id
                    },
                    function (game) {
                        summoner.currentGame = game;
                        AnnounceCurrentGameStart(summoner);
                    },
                    function (error, response) {
                        if (response === 404) {
                            // wasn't playing...
                            //announce(summoner.name + " was not playing");
                        }
                    }
                )
            }
        })(summoners[s]);
    }
}

bot.on('start', function () {
    // load summoners
    LoadSummoners(function () {
        setInterval(UpdateGameStates, 10000);
    });

    //doRequest(LastGames, { summonerId: 19869001 },
    //    function(games) {
    //        AnnounceGameEnd(summoners[1], games[0]);
    //    });

});

bot.on('message', function (message) {
    if (message.type == 'message' && message.text) {
        // todo : use an actual command parser
        var command = message.text.split(/[ ,]+/);

        if (command.length > 0 && command[0] == 'loltacle') {
            if (command[1] == 'observe') {
                var summonername = "";
                for (var i = 2; i < command.length; ++i) {
                    summonername += command[i] + " ";
                }
                summonername = summonername.trim();
                ObserveSummoner(summonername);
            } else if (command[1] == 'dontobserve') {
                var summonername = "";
                for (var i = 2; i < command.length; ++i) {
                    summonername += command[i] + " ";
                }
                summonername = summonername.trim();
                DontObserveSummoner(summonername);
            }
        }
    }
});