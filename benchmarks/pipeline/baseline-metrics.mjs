// Baseline wall-clock reconstruction from real git history (local HH:MM, 2026-11-03).
const T = {
  contractStart: '06:40', cp1: '11:03',
  red:  { 'T-01':'11:13','T-02':'12:11','T-03':'11:12','T-05':'12:36','T-08':'12:36','T-09':'11:13','T-11':'11:13','T-12':'11:13' },
  impl: { 'T-01':'11:41','T-02':'12:34','T-03':'12:16','T-05':null,'T-08':null,'T-09':'12:08','T-11':'12:24','T-12':'12:29' },
  merge:{ 'T-01':'12:00','T-02':'12:43','T-03':'12:24','T-05':null,'T-08':null,'T-09':'12:21','T-11':'12:32','T-12':'12:35' },
};
const m = (s) => { const [h,mi]=s.split(':').map(Number); return h*60+mi; };
const dur = (a,b) => m(b)-m(a);
console.log('contract phase minutes:', dur(T.contractStart,T.cp1));
const merged = Object.keys(T.merge).filter(k=>T.merge[k]);
console.log('tasks merged:', merged.length);
console.log('execution wall (first Red -> last merge):', dur('11:12','12:43'),'min');
for (const k of Object.keys(T.red)) {
  const red=m(T.red[k]); const impl=T.impl[k]?m(T.impl[k]):null; const mg=T.merge[k]?m(T.merge[k]):null;
  console.log(k, 'red->impl', impl?impl-red:'-', 'impl->merge', (impl&&mg)?mg-impl:'-', 'red->merge', mg?mg-red:'-');
}
const complete = merged.map(k=>dur(T.red[k],T.merge[k]));
console.log('mean red->merge for completed tasks:', (complete.reduce((a,b)=>a+b,0)/complete.length).toFixed(1),'min');
console.log('total from session start to last merge:', dur('06:40','12:43'),'min');
