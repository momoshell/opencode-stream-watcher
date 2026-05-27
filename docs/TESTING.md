# Manual stall testing

Use this guide to manually verify that stream-watchdog surfaces the default WARN behavior when a subagent stream goes quiet.

## Setup

1. Install dependencies and build the plugin:

   ```bash
   bun install
   bun run build
   ```

2. Symlink the built plugin into opencode's local plugin directory:

   ```bash
   mkdir -p ~/.config/opencode/plugins
   ln -sf "$(pwd)/dist/plugin.js" ~/.config/opencode/plugins/stream-watchdog.js
   ```

3. Restart opencode so it reloads local plugins.

4. Confirm the plugin loaded successfully by checking the opencode logs for the stream-watchdog startup entry:

   - Look under `~/.local/share/opencode/log/`.
   - Confirm you can find a log entry showing service `stream-watchdog` with a `loaded` startup message.

5. Confirm you are using the default config:
   - `warnThresholdMs: 90000`
   - `abortThresholdMs: 0`
   - `tickMs: 10000`
   - `toast: true`
   - `log: true`

## Run the fixture

1. Open a session that can launch a subagent.
2. Copy the prompt from [`../scripts/stall-fixture.md`](../scripts/stall-fixture.md).
3. Send it to a subagent and wait without interrupting the run.
4. Watch for a long quiet period with no visible stream updates.

Because manual reproduction depends on the local model/runtime, you may need to retry with a slower model or a broader prompt before you hit a long enough silent turn.

## Expected result

- With default settings, a sticky WARN toast should appear within about **95 seconds** of silence.
- The warning toast title should read **`⏸ Stream stalled`**.
- The message should tell the operator they can press **Esc** to interrupt the stuck run.
- A structured WARN log entry should also be emitted when logging is enabled.

The extra few seconds beyond the 90 second threshold account for the default 10 second scan interval.

## Verification checklist

- Plugin built and symlinked into `~/.config/opencode/plugins/stream-watchdog.js`
- opencode restarted after the symlink was created or refreshed
- Startup logs show `stream-watchdog` loaded successfully
- Sticky WARN toast appears within about **95 seconds** on default settings
- WARN toast title is **`⏸ Stream stalled`**
- WARN toast copy tells the operator to press **Esc** to interrupt
- WARN log entry is present in the opencode logs

## Cleanup

- After the warning appears, press **Esc** if you want to stop the stalled run.
- If the subagent eventually resumes on its own, let the turn finish and then start a new session for another trial if needed.
- Remove any local test symlink or temporary plugin setup when you are done.

## Troubleshooting

### No warning appeared

- The model may still be emitting small stream updates, so the watchdog never sees a full silent window.
- Retry with a slower model, a longer prompt, or a task that encourages more internal work before the final response.
- Verify the plugin is loaded and that `toast` or `log` has not been disabled.

### The subagent finished too fast

- Ask for a more detailed plan or broader repository review.
- Retry until you get a longer, quieter turn.

### You interrupted the run too early

- Start over and wait for the warning before pressing **Esc**.
