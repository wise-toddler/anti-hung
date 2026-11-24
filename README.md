# anti-hung

A Claude Code plugin that keeps chats from stopping for good when something goes wrong in the middle of a turn.

## What it does

- **Network drops:** when a turn dies because the machine lost the network (Wi-Fi drop, VPN switch, the laptop went to sleep), it checks the API every 10s, 20s, 40s, then every minute. Once it answers, the plugin sends `continue`.
- **Context full:** when a turn stops with "prompt is too long" or at the context limit, it runs `/compact` and then sends `continue`.
- **You come first:** if you type something before the network is back, the queued `continue` is dropped.
- **No loops:** at most 5 revivals in a row without an answered turn.
- **Self-update:** once a chat is idle, it picks up a newer installed version by itself (runs `/reload-plugins`).

Rate limits, billing and auth errors are left alone.

## Install

```
/plugin marketplace add wise-toddler/shivansh-mods
/plugin install anti-hung@shivansh-mods
```

## Test

```
claude plugin test .
```
