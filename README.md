# pi-loop

Simple in-session recurring prompt loops for [pi](https://pi.dev).

`pi-loop` adds a minimal `/loop` command that sends the same prompt repeatedly while your current pi session is open.

```txt
/loop 5m check CI and fix failures
/loops
/loop stop
```

## Install

From npm:

```bash
pi install npm:@presmihaylov/pi-loop
```

Or install from GitHub:

```bash
pi install git:github.com/presmihaylov/pi-loop
```

Or try it for one run:

```bash
pi -e npm:@presmihaylov/pi-loop
```

If you already have pi running after installing, run:

```txt
/reload
```

## Commands

### Start a loop

```txt
/loop <interval> <prompt>
```

Examples:

```txt
/loop 5m check CI and fix failures
/loop 30s check whether the dev server is still healthy
/loop 1h review PR comments
```

Supported interval units:

- `s` seconds
- `m` minutes
- `h` hours

When started, pi shows something like:

```txt
Started loop a3f9c2
Every 5m · next in 5m
```

### List loops

```txt
/loops
```

Also works:

```txt
/loop
/loop list
/loop ls
```

Example output:

```txt
Active loops
a3f9c2  every 5m   next in 3m   check CI and fix failures
b21aa8  every 1h   next in 42m  review PR comments
```

### Stop loops

The ergonomic command:

```txt
/loop stop
```

Examples:

```txt
/loop stop a3f
/loop stop all
```

## How it behaves

### Session-scoped only

Loops are intentionally in-memory only.

They stop when the current pi process/session ends, including:

- quitting pi
- closing the terminal
- `/new`
- `/resume`
- `/fork`
- `/reload`

They are **not** persisted to the session JSONL and are **not** restored later.

### Low priority, between turns

Loops do not interrupt active agent work.

If a loop is due while pi is busy, it waits until the agent is idle, then fires once.

Example:

```txt
Loop: every 5m
Agent busy: 12:00 → 12:30
```

At 12:30, the loop runs once, not six times.

### Missed intervals coalesce

Missed runs are collapsed into a single pending run. There is no catch-up storm.

```txt
12:05 loop due while busy
12:10 loop due again while busy
12:15 loop due again while busy
12:30 agent idle
12:30 loop runs once
12:35 next run
```

### Multiple due loops

If several loops become due while the agent is busy, each due loop runs once, sequentially, oldest-due first.

```txt
agent finishes
→ loop A prompt runs
agent finishes
→ loop B prompt runs
agent finishes
→ loop C prompt runs
```

## Footer status

While loops are active, the footer shows a compact status:

```txt
⟳ 2 loops
```

If any loops are due and waiting:

```txt
⟳ 2 loops · 1 due
```

## Design goals

This extension is deliberately small:

- no cron syntax
- no one-shot reminders
- no dynamic/self-paced mode
- no persistence after session close
- no LLM-callable scheduling tools

For full cron-style scheduling, use a larger scheduler extension. `pi-loop` is for lightweight recurring prompts during the session you are already working in.

## License

MIT
