# OpenCode 2.1.3 qualification — 2026-10-23

Candidate `70f6ee0a` was qualified on Linux x64 with Node 26.12.1, OpenCode
2.1.3, Claude Code 2.1.309, Meridian's built V2 plugin, and an independently
installed `@rynfar/meridian-plugin-opencode-scrub` 0.2.3
(`4ab89412e6a59fad812a3f6e5500c84f3bdfc41863320bc794f5274a251da656`).

Before inference, the read-only official usage probe returned 200 with included
capacity available and Extra Usage disabled. It made no model calls, credential
writes, or token refreshes. The live gate then used a private, access-token-only
profile (no refresh token) and ran in an isolated client, proxy, config, state,
and project environment.

`node scripts/e2e-opencode-host-isolation.mjs --live` passed. It verified the
actual client version and `setup --v2` installation, exactly one matching V2
plugin, active scrub before and after execution, signed primary requests, a
client-owned `mcp__oc__read` call and matching result, no proxy-host
instructions or MCP tools, and no foreign MCP invocation. The real
`claude-haiku-5-5` provider, native, and supported SDK-stored message identities
correlated. Every observed original process exit/close and stdout/stderr closure
joined; no overage or refusal signal occurred.

The gate is intentionally bounded. It proves actual 2.1.3 client/plugin/model
operation and client-owned tool isolation. The credential-free stable-host gate
separately covers continuation, effort, fork/original isolation, generated
subagents, and compaction; this live receipt does not extend actual-model proof
to those separate scenarios.
