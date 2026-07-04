// Count propagate/notify memory ops per visit on the driver shapes.
import { fileURLToPath } from 'node:url';
const lib = await import(fileURLToPath(new URL('../src/v-i-count.ts', import.meta.url)));
const { signal, computed, effect, ctr, resetCtr } = lib;

function run(name, build) {
	const { src, waves, dispose } = build();
	resetCtr();
	for (let i = 0; i < waves; i++) src(i);
	const v = ctr.visits;
	const per = (x) => (x / v).toFixed(3);
	console.log(`${name}: waves=${waves} visits=${v} perVisit{ flagLoads=${per(ctr.flagLoads)} flagStores=${per(ctr.flagStores)} flagRMWs=${per(ctr.flagRMWs)} linkLoads=${per(ctr.linkLoads)} nodeLoads=${per(ctr.nodeLoads)} stackPushes=${per(ctr.stackPushes)} notifies=${per(ctr.notifies)} }`);
	dispose();
}

run('deep', () => {
	const src = signal(1);
	let last = src;
	for (let i = 0; i < 100; i++) { const prev = last; last = computed(() => prev() + 1); }
	const d = effect(() => { last(); });
	return { src, waves: 2000, dispose: d };
});

run('broad', () => {
	const src = signal(1);
	const ds = [];
	for (let i = 0; i < 100; i++) { const c = computed(() => src() + i); ds.push(effect(() => { c(); })); }
	return { src, waves: 1000, dispose: () => ds.forEach((d) => d()) };
});
