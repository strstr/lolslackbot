const SlackBot = require('slackbots')
const request = require('request')
const jsonfile = require('jsonfile')
const moment = require('moment')
const _ = require('lodash`')

const SLACKBOT_API_KEY = process.env.SLACKBOT_API_KEY

// create a bot
const bot = new SlackBot({
    token: SLACKBOT_API_KEY,
    name: 'LOLtacle', // todo: load from env or config
})

const RIOT_API_KEY = process.env.RIOT_API_KEY
const RIOT_API_ROOT_URL = 'https://na.api.pvp.net/'

const maps = {}
maps[8] = 'Crystal Scar'
maps[10] = 'Twisted Treeline'
maps[11] = "Summoner's Rift"
maps[12] = 'Howling Abyss'


// /////////////////////
// riot api wrap
function makeCallURL(apicall, params) {
    let parametrizedCall = apicall
    for (const paramName in params) {
        if ({}.hasOwnProperty.call(params, paramName)) {
            parametrizedCall = parametrizedCall.replace(`'{${paramName}}`, params[paramName])
        }
    }

    return RIOT_API_ROOT_URL + parametrizedCall + '?api_key=' + RIOT_API_KEY
}

const SummonerByName = {
    url: 'api/lol/na/v1.4/summoner/by-name/{summonername}',
    parser: body => {
        const players = JSON.parse(body)
        for (const player in players) {
            return players[player]
        }
        return null
    },
}

const CurrentGame = {
    url: 'observer-mode/rest/consumer/getSpectatorGameInfo/NA1/{summonerId}',
    parser: body => JSON.parse(body),
}

const LastGames = {
    url: '/api/lol/na/v1.3/game/by-summoner/{summonerId}/recent',
    parser: body => JSON.parse(body).games,
}

const ChampionNameById = {
    url: '/api/lol/static-data/na/v1.2/champion/{id}',
    parser: body => JSON.parse(body).name,
}

const workqueue = []

const workdebugout = msg => {
    // console.log(msg);
}

// const working = false

let currentjob
const pumpqueue = () => {
    workdebugout(`queue has ${workqueue.length} entries`)

    if (workqueue.length && !currentjob) {
        currentjob = workqueue[0]
        workqueue.splice(0, 1)
        workdebugout(`doing work for job ${currentjob.index}`)
        currentjob.run()
        workdebugout(`running work for ${currentjob.index}`)
    }

    if (currentjob && currentjob.responded) {
        workdebugout(`finished handling response for ${currentjob.index}`)
        currentjob = null
    }
}

const workdelay = 2000
setInterval(pumpqueue, workdelay)

let jobcounter = 0
function doRequest(call, params, payloadFun, errorFun) {
    workdebugout(`queueing ${makeCallURL(call.url, params)}`)

    const job = {}
    job.index = jobcounter++
    job.run = () => {
        const c = makeCallURL(call.url, params)
        workdebugout(`requesting ${c}`)
        request(c, (err, response, body) => {
            if (err || response.statusCode !== 200) {
                if (err && response && response.statusCode === 429) {
                    console.log('too many requests')
                }

                workdebugout('error ' + (response ? response.statusCode : 'no response'))

                const statuscode = response ? response.statusCode : 0
                if (statuscode === 401) {
                    console.log('key error for RIOT API')
                }

                if (errorFun) errorFun(err, statuscode)
                job.responded = true
                return
            }

            workdebugout(`running ${c}`)
            payloadFun(call.parser(body))
            job.responded = true
        })
    }

    job.url = makeCallURL(call.url, params)
    workqueue.push(job)
}

// /////////////////////
// slackbot api wrap
const announceparams = {
    icon_url: 'https://avatars.slack-edge.com/2016-04-17/35396496742_2e722be390b0de1bd9cc_48.png',
}

function announce(msg) {
    console.log(msg)
    bot.postMessageToChannel('leagueoflegends', msg, announceparams)
}

// lolbot api

const summonersfile = 'summoners.json'

// should be loaded from persistence
const summoners = []

function findSummonerByName(summonername) {
    summonername = summonername.toLowerCase()
    return _.find(summoners, summoner => summoner.name.toLowerCase() === summonername)
}

function saveSummoners() {
    jsonfile.writeFileSync(summonersfile, summoners)
}

function addSummoner(summoner) {
    summoners.push(summoner)
    saveSummoners()
}

function removeSummonerByName(summonername) {
    summonername = summonername.toLowerCase()
    _.pullAllWith(summoners, name => name.toLowerCase() === summonername)
    saveSummoners()
}

function loadSummoners(then) {
    summoners = jsonfile.readFileSync(summonersfile)

    const invalidSummoners = []
    let donecount = 0
    const didnothing = true

    _(summoners)
        .filter(s => !s.id)
        .forEach(summoners, summoner => {
            doRequest(SummonerByName, { summonername: summoner.name },
                summoneronserver => {
                    summoner.id = summoneronserver.id

                    saveSummoners()

                    // the horror
                    donecount++
                    if (then && donecount === summoners.length) {
                        then()
                    }
                },
                (error, response) => {
                    invalidSummoners.push(summoner)

                    // THE HORROR
                    donecount++
                    if (then && donecount === summoners.length) {
                        then()
                    }
                }
            )
        })

    if (didnothing) {
        then()
    }

    // todo : reconcile or remove invalidSummoners
}

function observeSummoner(summonername, then) {
    if (findSummonerByName(summonername)) {
        announce(`${summonername} is already under observation`)
        if (then) then()
    } else {
        doRequest(SummonerByName, { summonername },
            summoner => {
                const newSummoner = {
                    name: summoner.name,
                    id: summoner.id,
                    currentGame: null,
                }

                announce(`now observing ${summoner.name}`)

                doRequest(CurrentGame, { summonerId: summoner.id },
                    game => {
                        if (!summoner.currentGame || summoner.currentGame.gameId !== game.gameId) {
                            announce(`${summoner.name} is currently in a game`)
                            summoner.currentGame = game
                        }

                        addSummoner(newSummoner)
                    },
                    (error, response) => {
                        if (response === 404) {
                            // wasn't playing...
                        }

                        addSummoner(newSummoner)
                        console.log(`error? ${summoner.id} ${response}`)
                    }
                )

                if (then) then()
            },
            (error, response) => {
                announce(`unknown summoner ${summonername}`)
                if (then) then()
            }
        )
    }
}

function dontObserveSummoner(summonername, then) {
    if (!findSummonerByName(summonername)) {
        announce(`${summonername} is already not under observation`)
        if (then) then()
    } else {
        removeSummonerByName(summonername)
        announce(`not observing ${summonername} anymore`)
        if (then) then()
    }
}

function announceCurrentGameStart(summoner) {
    if (summoner.gamestartsannounced &&
        summoner.gamestartsannounced.indexOf(summoner.currentGame.gameId) !== -1) {
        // already announced
        return
    }

    if (!summoner.gamestartsannounced) {
        summoner.gamestartsannounced = []
    }

    let champId

    for (const p in summoner.currentGame.participants) {
        if (summoner.currentGame.participants[p].summonerId === summoner.id) {
            champId = summoner.currentGame.participants[p].championId
        }
    }

    summoner.gamestartsannounced.push(summoner.currentGame.gameId)
    saveSummoners()

    doRequest(ChampionNameById, { id: champId },
        champname => {
            summoner.lastchamp = champname
            announce(`${summoner.name} has just started game on ${maps[summoner.currentGame.mapId]} ( ${summoner.currentGame.gameMode} ) playing ${summoner.lastchamp}`)
        })
}

function formatGameTime(seconds) {
    return moment.duration(seconds, 'seconds').format('mm:ss')
}

function announceGameEnd(summoner, game) {
    const result = game.stats.win ? 'won ' : 'lost '
    const formattedgame = `${maps[game.mapId]} ( ${game.gameMode} )`

    const numDeaths = game.stats.numDeaths ? game.stats.numDeaths : '0'
    const championsKilled = game.stats.championsKilled ? game.stats.championsKilled : '0'
    const assists = game.stats.assists ? game.stats.assists : '0'
    const score = `${championsKilled}/${numDeaths}/${assists}`

    announce(`${summoner.name} as ${summoner.lastchamp} just scored ${score} and ${result} on ${formattedgame} in ${formatGameTime(game.stats.timePlayed)} minutes`)
}

function UpdateGameStates() {
    if (workqueue.length) return

    _(summoners).forEach(summoner => {
        if (summoner.currentGame && !summoner.waitingforresult) {
            doRequest(CurrentGame, { summonerId: summoner.id },
                game => {
                    // still playing
                    summoner.currentGame = game
                },
                (error, response) => {
                    if (response === 404) {
                        // game ended
                        summoner.waitingforresult = true
                    }
                }
            )
        } else if (summoner.currentGame && summoner.waitingforresult) {
            doRequest(LastGames, { summonerId: summoner.id },
                games => {
                    for (const game in games) {
                        if (summoner.currentGame && games[game].gameId === summoner.currentGame.gameId) {
                            announceGameEnd(summoner, games[game])
                            summoner.waitingforresult = false
                            delete summoner.currentGame // assign null does fuckall
                            saveSummoners()
                        }
                    }
                }
            )
        } else {
            doRequest(CurrentGame, { summonerId: summoner.id },
                game => {
                    summoner.currentGame = game
                    announceCurrentGameStart(summoner)
                },
                (error, response) => {
                    if (response === 404) {
                        // wasn't playing...
                        // announce(summoner.name + " was not playing")
                    }
                }
            )
        }
    })
}

bot.on('start', () => {
    // load summoners
    loadSummoners(() => { setInterval(UpdateGameStates, 10000) })

    // doRequest(LastGames, { summonerId: 19869001 },
    //    function(games) {
    //        AnnounceGameEnd(summoners[1], games[0]);
    //    });
})

bot.on('message', message => {
    if (message.type === 'message' && message.text) {
        // todo : use an actual command parser
        const command = message.text.split(/[ ,]+/)

        if (command.length > 0 && command[0] === 'loltacle') {
            if (command[1] === 'observe') {
                let summonername = ''
                for (let i = 2; i < command.length; ++i) {
                    summonername += command[i] + ' '
                }
                summonername = summonername.trim()
                observeSummoner(summonername)
            } else if (command[1] === 'dontobserve') {
                let summonername = ''
                for (let i = 2; i < command.length; ++i) {
                    summonername += command[i] + ' '
                }
                summonername = summonername.trim()
                dontObserveSummoner(summonername)
            }
        }
    }
})
