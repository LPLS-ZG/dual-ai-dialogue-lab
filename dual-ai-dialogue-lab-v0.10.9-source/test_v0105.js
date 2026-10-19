const fs=require('fs'),path=require('path'),assert=require('assert');
const root=__dirname, content=fs.readFileSync(path.join(root,'install/content.js'),'utf8'), side=fs.readFileSync(path.join(root,'install/sidepanel.js'),'utf8'), manifest=JSON.parse(fs.readFileSync(path.join(root,'install/manifest.json'),'utf8'));
assert.ok(manifest.version.localeCompare('0.10.5') >= 0, '版本应不低于 0.10.5');
assert(content.includes('自动核验未能在稳定界面中重新识别本轮附件'));
assert(content.includes('此结果不等于文件已上传失败或已被网页移除'));
assert(content.includes("failureClass:'page-upload-error'"));
assert(side.includes('自动核验未能确认全部附件，将暂停并请求人工核对'));
assert(side.includes('人工目视确认'));
console.log('v0.10.5 regression checks passed');
