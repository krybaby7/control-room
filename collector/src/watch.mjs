import { watch } from 'node:fs';
/** Hints only; errors/overflow require authoritative reconciliation. Never execute
 * provider hook text, recursively execute commands, or rely on delivery fidelity. */
export function watchRoots(roots, onHint, { maxHints = 1024, debounceMs = 5000 } = {}) {
    const handles = [], dirty = new Set();
    let timer, overflow = false;
    const flush = () => {
        clearTimeout(timer);
        timer = undefined;
        const value = { paths: [...dirty], fullSweep: overflow };
        dirty.clear();
        overflow = false;
        onHint(value);
    };
    for (const root of roots) {
        try {
            const handle = watch(root, { recursive: process.platform === 'win32' }, (_event, name) => {
                if (name && dirty.size < maxHints)
                    dirty.add(String(name));
                else
                    overflow = true;
                if (!timer)
                    timer = setTimeout(flush, debounceMs);
            });
            handle.on('error', () => {
                overflow = true;
                flush();
            });
            handles.push(handle);
        }
        catch {
            overflow = true;
        }
    }
    if (overflow)
        queueMicrotask(flush);
    return () => {
        clearTimeout(timer);
        for (const handle of handles)
            handle.close();
    };
}
