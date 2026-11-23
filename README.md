<div align="center">

# HumanWire

Meet and talk to real people in your AI agent chat.

<p>
  <a href="https://github.com/DeepLeap/humanwire/releases"><img src="https://img.shields.io/github/v/release/DeepLeap/humanwire?style=flat-square" alt="GitHub release" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0D0D0D?style=flat-square&labelColor=0D0D0D&color=F2F5F1" alt="MIT License" /></a>
</p>

<p><b>English</b> | <a href="./README.zh-CN.md">简体中文</a></p>

</div>

HumanWire matches you one-on-one with someone online who shares your interests. You can send messages and see the other person's replies in that same AI conversation through MCP. For live replies while your AI is idle, open the HumanWire chat window.

> **You:** Find someone else who’s building a personal website.
>
> **Peer, after matching:** I’m working on my site’s mobile layout. What are you building?

## Start from your AI agent

Use the GitHub source with **Node.js 22 or later**. Configure your AI client to run HumanWire as a local stdio MCP server. Replace the example path with the absolute path to your checkout:

```json
{
  "mcpServers": {
    "humanwire": {
      "command": "node",
      "args": ["/absolute/path/to/humanwire/src/index.js"]
    }
  }
}
```

Ask your AI to find someone who shares an interest, or find a stranger for casual chat. It can start a match with `start_matching`, send your messages with `send_to_peer`, and bring replies back into the same conversation with `poll_messages`. The host displays replies when it calls the receive tool, which can wait up to 25 seconds per call.

For live replies while the AI is idle, add `--chat-window` to the launch arguments. Starting or retrying a match then opens the window for that session. Use `open_chat_window` to reopen it. The window receives and sends messages independently while the local MCP process runs. Desktop unread notifications and on-device translation depend on browser support. See the [host integration guide](./docs/INTEGRATION.md) and [agent workflow](./SKILL.md).

These examples use the current GitHub source. Check the version on [npm](https://www.npmjs.com/package/humanwire-mcp) before using these features with a registry install.

## Use the standalone chat window

Use the GitHub source for this quick start. It requires **Node.js 22 or later**.

```sh
git clone https://github.com/DeepLeap/humanwire.git
cd humanwire
npm run chat
```

1. Open the local link printed in your terminal.
2. Enter a nickname and up to five public keywords, such as `personal websites, frontend`. Add an optional short introduction for your match to see. Leave keywords blank for casual chat.
3. Click **开始匹配** (start matching). When you connect, type in the chat window and press Enter. Click **结束** (end) to leave.

HumanWire normalizes case, spacing, and common full-width characters. In keyword mode, both sides must be searching and have at least one normalized keyword in common. For example, `Personal Websites, Frontend` can match `personal websites, css`. Matching uses keyword overlap; availability depends on other people being online. You can ask an AI to suggest keywords from your public interests before you search.

A search waits for up to 60 seconds by default. When it times out or the other person disconnects, you can search again with your previous interests. The window shows shared topics and the introduction the peer chose to share. It keeps up to 200 events from the current session in memory so you can refresh or reopen the same local window. Leaving, starting another session, or stopping HumanWire clears that record.

For Octo, use the [local MCP setup](./docs/OCTO.md). The setup uses the same HumanWire service and chat window.

## Invite a friend or visit the plaza

- **Room code**. Choose the room option in the chat window or call `join_room` through MCP. Create a code to share with a friend, or enter a code someone sent you.
- **Public plaza**. In native MCP mode, `join_plaza` opens a public topic board. Nostr relays can supply recent posts within a 24-hour window, subject to relay availability. Treat posts as public.

## Network and privacy

HumanWire uses the Node.js standard library for its default relay mode. Private chats are encrypted over public Nostr relays. Relay operators can still see connection metadata, including the incoming IP address, or the proxy exit IP if you connect through a proxy. A nickname and handshake establish a connection, with no real-world identity verification.

- **Proxy**. Add `--proxy socks5h://127.0.0.1:9050` or `--proxy http://127.0.0.1:7890` to the MCP launch arguments if you have a compatible local proxy. `socks5h` resolves relay hostnames remotely.
- **Your own relays**. Use `--relays wss://relay.example.com` or `HUMANWIRE_RELAYS` for a comma-separated relay list. Participants need reachable shared relays. History availability follows the configured relay's policy.
- **Direct P2P**. With the optional `hyperswarm` dependency available, `--transport p2p --allow-ip-exposure` enables direct connections. Peers may see your public IP and port. Keep the default relay mode if you prefer to avoid direct IP exposure to strangers.
- **Peer content**. Treat incoming text, links, and images as untrusted. Text filters cover common credentials and sensitive patterns. The native MCP path labels incoming text as untrusted. In that mode, incoming images stay in memory until requested through `inspect_image`.

## MCP tools

| Tool | What it does |
| :--- | :--- |
| `start_matching` | Start stranger matchmaking with 1–5 comma-separated `keywords`. If omitted, the server matches by exact `channel`, which defaults to `chat/casual`. |
| `retry_matching` | Search again using your previous match preferences after a timeout or disconnect. |
| `open_chat_window` | Open the window for the active session in `--chat-window` mode. |
| `join_room` | Create or join an encrypted room using a shared room code. |
| `get_status` / `leave_chat` | Check status or leave the active session. |
| `poll_messages` / `send_to_peer` | Fetch and send text in native MCP mode. Sending supports optional `auto_sanitize`. |
| `join_plaza` | Join the public plaza in native MCP mode. |
| `send_image_file` / `inspect_image` | Send PNG, JPEG, or WebP, or inspect an image held in memory, in native MCP mode. |
| `issue_vouch` | Give a peer a signed vouch in native MCP mode. |
| `manage_blocklist` | List, add, or remove locally blocked node keys. Adding without a key selects the current sole peer. |
| `clear_media_vault` | Discard received images while keeping the current chat, in native MCP mode. |

## Development

Run `npm test` in the repository. See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for implementation details and [INTEGRATION.md](./docs/INTEGRATION.md) for host adaptation. The [development roadmap](./docs/ROADMAP.md) tracks priorities, progress, and acceptance criteria (in Chinese).

## License

MIT © [YUKE · DeepLeap](https://github.com/DeepLeap) ([dangiakodi@gmail.com](mailto:dangiakodi@gmail.com))
