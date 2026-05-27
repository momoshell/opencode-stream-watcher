# Manual stall fixture

Use this fixture to try to trigger a long, quiet subagent turn while the stream-watchdog plugin is running.

This is a manual, dev-only recipe. Exact behavior depends on the local model, provider, and runtime, so you may need a couple of tries before you get a silent stall long enough to trigger the warning.

## Prompt template

Paste a prompt like this into opencode and send it to a subagent:

```text
Read the full repository carefully and prepare a detailed implementation plan for a future change.

Requirements:
- Do not make any code changes.
- Read several source files before you answer.
- Think through the plan before you write anything.
- Do not stream partial progress updates unless they are absolutely necessary.
- Return one complete final answer at the end with sections for findings, risks, and step-by-step implementation.
```

## Operator notes

- Prefer a larger or slower model if you have one available.
- Prefer a task that forces repository reading and planning rather than a quick factual answer.
- The goal is a long stretch with no visible `message.part.updated` activity from the subagent.
- If the subagent responds too quickly, retry with a broader prompt, ask for more detail, or tell it to inspect more files before answering.
- Leave the turn alone once it starts. Do not press **Esc** unless you want to stop the run.
- This fixture is only meant to reproduce the WARN path, not to guarantee a stall on every machine.
