# lolslackbot
a slack bot for league of legends

## usage
on server, set environment variables RIOT_API_KEY and SLACK_API_KEY with your respective API keys, then run lolbot.js in nodejs to start monitoring loop.

## slack commands

\<botname> observe \<summoner name> : start observing summoner, announcing game starts and results

\<botname> dontobserve \<summoner name> : stop observing summoner

## known issues
* repeats current game when rebooting the bot while summoners are in-game
* bot name and output channels are hardcoded, should come from config or env vars
