#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthManager } from "./auth.js";
import { XClient } from "./client.js";
import { appFilePath, loadConfig, saveClientId } from "./config.js";
import { createPost } from "./posts.js";
import { createServer } from "./server.js";
import { TokenStore } from "./store.js";
import { VERSION } from "./version.js";

const cfg = loadConfig();
const client = new XClient(cfg, new TokenStore(cfg.homeDir));
const auth = new AuthManager(client);

const HELP = `x-api-mcp ${VERSION} - local stdio MCP server for the X API

Usage:
  x-api-mcp                      Run the MCP server on stdio (what MCP clients launch)
  x-api-mcp config --client-id <id> [--client-secret <s>]
                                 Save your X App's Client ID locally
  x-api-mcp login                Authorize an X account in your browser
  x-api-mcp accounts             List authorized accounts
  x-api-mcp default <username>   Set the default account
  x-api-mcp logout <username>    Remove an account and revoke its tokens
  x-api-mcp post [--account a] <text>   Publish a post (quick test)

Env: X_CLIENT_ID, X_CLIENT_SECRET (confidential apps only), X_AUTH_MODE (auto|loopback|paste),
     X_TOOLS (all|write|read), X_REQUIRE_ACCOUNT, X_ENABLE_DM, X_SCOPES,
     X_REDIRECT_URI (default http://127.0.0.1:8765/callback), X_API_MCP_HOME (default ~/.x-api-mcp)`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "serve": {
      const server = createServer(client, auth);
      await server.connect(new StdioServerTransport());
      return;
    }
    case "login": {
      const r = await auth.start();
      console.error(`\nOpen this URL in a browser signed in to the X account you want to add:\n\n${r.authorize_url}\n`);
      if (!r.listening) {
        console.error(r.note);
        const url = await prompt("Paste the callback URL here: ");
        print(await auth.complete({ redirect_url: url }));
        return;
      }
      tryOpen(r.authorize_url);
      console.error("Waiting for the browser callback (Ctrl+C to cancel)...");
      const s = await auth.wait(r.state, 15 * 60_000);
      auth.close();
      if (s.status === "done") print(s.result);
      else throw new Error(s.status === "error" ? s.error : "Timed out waiting for authorization.");
      return;
    }
    case "config": {
      const opts: Record<string, string> = {};
      for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, "")] = rest[i + 1];
      saveClientId(cfg, need(opts["client-id"], "--client-id"), opts["client-secret"]);
      console.log(`Saved Client ID to ${appFilePath(cfg.homeDir)}`);
      return;
    }
    case "accounts": {
      const d = client.store.read();
      for (const [k, a] of Object.entries(d.accounts)) {
        console.log(`${d.default_account === k ? "*" : " "} @${a.username}  (${a.user_id})  token until ${new Date(a.expires_at).toISOString()}`);
      }
      if (!Object.keys(d.accounts).length) console.log("No accounts yet. Run: x-api-mcp login");
      return;
    }
    case "default": {
      const key = client.resolveAccount(need(rest[0], "username"));
      await client.store.withLock(async () => {
        const d = client.store.read();
        d.default_account = key;
        client.store.write(d);
      });
      console.log(`Default account: @${client.getAccount(key).username}`);
      return;
    }
    case "logout":
      print(await auth.remove(need(rest[0], "username")));
      return;
    case "post": {
      let account: string | undefined;
      if (rest[0] === "--account") [, account] = rest.splice(0, 2);
      print(await createPost(client, { account, text: need(rest.join(" "), "text") }));
      return;
    }
    case "-v":
    case "--version":
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
      if (cmd !== "help" && cmd !== "-h" && cmd !== "--help") process.exitCode = 2;
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`Missing ${what}.\n\n${HELP}`);
  return v;
}
function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}
async function prompt(q: string): Promise<string> {
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}
function tryOpen(url: string) {
  import("node:child_process").then(({ spawn }) => {
    const [cmd, args] =
      process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    try {
      spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    } catch {}
  });
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`Error: ${e?.message ?? e}`);
  process.exit(1);
});
