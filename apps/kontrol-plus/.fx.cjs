const fs=require('fs');const p='tests/docs-from-request.test.mjs';let s=fs.readFileSync(p,'utf8');
const a="assert.doesNotMatch(read('src/views/docs-request-picker.js'), /disabled|submit\.disabled|return false/);";
if(!s.includes(a))throw new Error('x');
s=s.replace(a,()=>"const pickerCode = read('src/views/docs-request-picker.js');\n    assert.doesNotMatch(pickerCode.slice(0, pickerCode.indexOf('// Прив')), /disabled|submit\.disabled|return false/); // блок привʼязки клієнта нижче має власні кнопки");
fs.writeFileSync(p,s);
