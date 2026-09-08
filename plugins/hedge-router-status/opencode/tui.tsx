import { Plugin } from '@opencode-ai/plugin/tui';
import { createSignal, onCleanup, onMount } from 'solid-js';

async function readStatus(directory: string) {
  try {
    const child = Bun.spawn(['hedge-router', 'status'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'ignore'
    });
    const output = await new Response(child.stdout).text();
    const code = await child.exited;
    return code === 0 ? output.trim() : 'hedge router · unavailable';
  } catch {
    return 'hedge router · unavailable';
  }
}

export default Plugin.define({
  id: 'hedge-router.status',
  setup(context) {
    const directory = context.location?.directory ?? context.data.location.default().directory;

    function Status() {
      const [label, setLabel] = createSignal('hedge router · loading');
      let refreshing = false;
      const refresh = async () => {
        if (refreshing) return;
        refreshing = true;
        try { setLabel(await readStatus(directory)); }
        finally { refreshing = false; }
      };

      onMount(() => void refresh());
      const timer = setInterval(() => void refresh(), 2000);
      onCleanup(() => clearInterval(timer));
      return <text fg={context.theme.text.default}>{label()}</text>;
    }

    return context.ui.slot({ append: 'prompt.footer.status', render: Status });
  }
});
