// @vitest-environment jsdom
import { expect, test } from 'vitest';
test('royale adapters load and register', async () => {
	const adapter = (await import('../royale/adapter.ts')).default;
	expect(adapter.slug).toBe('fm1');
	const handle = adapter.register();
	expect(handle.errors).toEqual([]);
	const daishi = (await import('../royale/daishi-adapter.tsx')).default;
	expect(typeof daishi.useCount).toBe('function');
	const seam = (await import('../royale/seam-bench-adapter.ts')).default;
	const store = seam.createCells(3);
	store.writeCell(0, 5);
	store.dispose();
	expect(seam.name).toBe('royale-fm1');
});
