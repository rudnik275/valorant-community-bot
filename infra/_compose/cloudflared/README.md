# cloudflared sidecar

`creds.json` lives only on the VPS under `/opt/_infra/cloudflared/creds.json` (chmod 600).
It is **never** committed to this repository.

To obtain `creds.json`:
1. Run `cloudflared tunnel create <name>` locally (or on any machine with CF credentials).
2. Copy the generated JSON file from `~/.cloudflared/<TUNNEL_UUID>.json`.
3. `scp` it to the VPS: `scp ~/.cloudflared/<TUNNEL_UUID>.json user@vps:/opt/_infra/cloudflared/creds.json`
4. On the VPS: `chmod 600 /opt/_infra/cloudflared/creds.json`

Fill in `<TUNNEL_UUID>` in `config.yml` and replace `bot.example.com` with the real hostname.
