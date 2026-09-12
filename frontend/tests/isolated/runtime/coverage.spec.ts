import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";

function probe(source: string) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "", NODE_OPTIONS: "" },
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout.trim());
}

test("coverage denominator includes never-imported TS and TSX but no type-only statements", () => {
  const result = probe(String.raw`
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import CoverageReport from 'monocart-coverage-reports';
    import {generateDenominator} from './scripts/coverage-report.mjs';
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-test-'));
    try {
      const entries=[
        {url:'src/unloaded.ts',source:'// Comment only\nexport type Name = string;\n\nexport function value(): number {\n  return 7;\n}\n'},
        {url:'src/unloaded.tsx',source:'export function View() {\n  return <button>Save</button>;\n}\n'},
        {url:'src/types.ts',source:'export type Name = string;\n'},
      ];
      const data=await generateDenominator(entries,directory);
      console.log(JSON.stringify(Object.fromEntries(data.files().map(key=>[key,data.fileCoverageFor(key).getLineCoverage()]))));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  `);
  expect(result["src/unloaded.ts"]).toEqual({ "4": 0, "5": 0 });
  expect(result["src/unloaded.tsx"]).toEqual({ "1": 0, "2": 0 });
  expect(result["src/types.ts"]).toEqual({});
});

test("coverage rejects stale mapped sources and missing capture directories", () => {
  const result = probe(String.raw`
    import {validateMap,generate,hash,validateCaptureIds,canonical} from './scripts/coverage-report.mjs';
    const errors=[];
    try {validateMap({sources:['src/example.ts'],sourcesContent:['stale']},{'src/example.ts':hash('current')})} catch(error) {errors.push(error.message)}
    try {await generate('/tmp/openslate-coverage-nonexistent',{})} catch(error) {errors.push(error.message)}
    try {validateCaptureIds(['a','b'],['a'])} catch(error) {errors.push(error.message)}
    if(canonical('node_modules/vendor/src/lib/files.ts')!==null) throw new Error('Vendor collision');
    console.log(JSON.stringify(errors));
  `);
  expect(result).toEqual([
    "Missing or stale source-map content: src/example.ts",
    "Missing browser captures",
    "Missing or duplicate browser test captures",
  ]);
});

test("partial V8 ranges cannot imply whole-source execution", () => {
  const result = probe(String.raw`
    import {validateRanges} from './scripts/coverage-report.mjs';
    const errors=[];
    for (const functions of [[],[{ranges:[{startOffset:0,endOffset:2,count:1}]}]]) {
      try {validateRanges({url:'src/example.ts',source:'const value=1;',functions})} catch(error) {errors.push(error.message)}
    }
    console.log(JSON.stringify(errors));
  `);
  expect(result).toEqual([
    "Partial V8 capture: src/example.ts",
    "Partial V8 capture: src/example.ts",
  ]);
});

test("real V8 execution distinguishes an untaken branch and merges duplicate source once", () => {
  const result = probe(String.raw`
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import inspector from 'node:inspector/promises'; import vm from 'node:vm';
    import CoverageReport from 'monocart-coverage-reports'; import istanbul from 'istanbul-lib-coverage';
    import {transformUntested,canonical,validateRanges,selectCompleteEntries} from './scripts/coverage-report.mjs';
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-test-'));
    const entry={url:'src/branch.ts',source:'function choose(flag: boolean | null) {\n  if (flag === true) {\n    return 1;\n  }\n  if (flag === false) {\n    return 2;\n  }\n  return 3;\n}\nchoose(true);\n'};
    transformUntested(entry);
    const session=new inspector.Session();session.connect();
    try {
      await session.post('Profiler.enable'); await session.post('Profiler.startPreciseCoverage',{callCount:true,detailed:true});
      vm.runInThisContext(entry.source,{filename:'src/branch.ts'});
      const {result}=await session.post('Profiler.takePreciseCoverage');
      vm.runInThisContext('choose(false);');
      const second=await session.post('Profiler.takePreciseCoverage'); await session.post('Profiler.stopPreciseCoverage');
      const runtime={...result.find(item=>item.url==='src/branch.ts'),...entry};validateRanges(runtime);
      const report=new CoverageReport({outputDir:directory,reports:['json'],logging:'off',v8Ignore:false,sourcePath:path=>canonical(path)??path});
      const fragment={...second.result.find(item=>item.url==='src/branch.ts'),...entry};
      const selected=selectCompleteEntries([runtime,fragment]);
      await report.add(selected.complete);await report.add(selected.complete);await report.generate();
      const map=istanbul.createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory,'coverage-final.json'))));
      console.log(JSON.stringify({files:map.files(),fragments:selected.discardedFragments,lines:map.fileCoverageFor('src/branch.ts').getLineCoverage()}));
    } finally {session.disconnect();fs.rmSync(directory,{recursive:true,force:true});}
  `);
  expect(result.files).toEqual(["src/branch.ts"]);
  expect(result.lines["3"]).toBeGreaterThan(0);
  expect(result.lines["6"]).toBeGreaterThan(0);
  expect(result.lines["8"]).toBe(0);
  expect(result.fragments).toBe(0);
});

test("relative inline maps retain their exact script directory and source hash check", () => {
  const result = probe(String.raw`
    import {sourceMap,validateMap,hash} from './scripts/coverage-report.mjs';
    const map={version:3,sources:['example.ts'],sourcesContent:['stale'],names:[],mappings:''};
    const source='//# sourceMappingURL=data:application/json;base64,'+Buffer.from(JSON.stringify(map)).toString('base64');
    const resolved=sourceMap(source,'file:///project/src/lib/example.ts');
    let error='';try {validateMap(resolved,{'src/lib/example.ts':hash('current')})} catch(reason) {error=reason.message;}
    console.log(JSON.stringify({sources:resolved.sources,error}));
  `);
  expect(result.sources).toEqual(["file:///project/src/lib/example.ts"]);
  expect(result.error).toBe(
    "Missing or stale source-map content: src/lib/example.ts",
  );
});

test("Next boundary-only lines are non-executable while mixed statements remain", () => {
  const result = probe(String.raw`
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import {generateDenominator} from './scripts/coverage-report.mjs';
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-directives-'));
    try {
      const entries=[
        {url:'src/client.ts',source:'"use client";\nexport function value() {\n  return 7;\n}\n'},
        {url:'src/server.ts',source:'"use server";\nexport async function value() {\n  return 7;\n}\n'},
        {url:'src/mixed.ts',source:'"use client"; work();\n'},
        {url:'src/import.ts',source:'"use client";\nimport "./client";\n'},
      ];
      const data=await generateDenominator(entries,directory);
      console.log(JSON.stringify(Object.fromEntries(data.files().map(key=>[key,data.fileCoverageFor(key).getLineCoverage()]))));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  `);
  expect(result["src/client.ts"]).toEqual({ "2": 0, "3": 0 });
  expect(result["src/server.ts"]).toEqual({ "2": 0, "3": 0 });
  expect(result["src/mixed.ts"]).toEqual({ "1": 0 });
  expect(result["src/import.ts"]).toEqual({});
});

for (const missing of ["browser-map", "worker-data", "server-data"]) {
  test(`coverage rejects ${missing} even when other runtimes have valid captures`, () => {
    const result = probe(String.raw`
      import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
      import {pathToFileURL} from 'node:url';
      import {generate,transformUntested,hash} from './scripts/coverage-report.mjs';
      const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-missing-'));
      const mode=${JSON.stringify(missing)};
      try {
        fs.mkdirSync(path.join(directory,'browser'));fs.mkdirSync(path.join(directory,'node'));
        const target='src/lib/utils.ts';const original=fs.readFileSync(target,'utf8');const url=pathToFileURL(path.resolve(target)).href;
        const compiled={url:target,source:original};transformUntested(compiled);compiled.sourceMap.sources=[url];
        const source=compiled.source+'\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(JSON.stringify(compiled.sourceMap)).toString('base64');
        const entry={url,scriptId:'1',source,functions:[{functionName:'',isBlockCoverage:true,ranges:[{startOffset:0,endOffset:source.length,count:0}]}]};
        const browser=[entry];
        if(mode==='browser-map')browser.push({...entry,scriptId:'2',source:'export const missed = 1;'});
        fs.writeFileSync(path.join(directory,'browser/test.json'),JSON.stringify({testId:'test',status:'passed',entries:browser}));
        for(const pid of [101,102]){
          fs.writeFileSync(path.join(directory,'node/process-'+pid+'.json'),JSON.stringify({entrypoint:pid===101?'next/dist/server/lib/start-server.js':'playwright/lib/worker/workerProcessEntry.js'}));
          fs.writeFileSync(path.join(directory,'node/source-'+pid+'.json'),JSON.stringify({...entry,pid}));
          fs.writeFileSync(path.join(directory,'node/coverage-'+pid+'-1-0.json'),JSON.stringify({result:[entry]}));
        }
        fs.writeFileSync(path.join(directory,'node/flushed-101'),'complete');
        if(mode==='worker-data')fs.writeFileSync(path.join(directory,'node/process-103.json'),JSON.stringify({entrypoint:'playwright/lib/worker/workerProcessEntry.js'}));
        if(mode==='server-data'){
          fs.writeFileSync(path.join(directory,'node/process-103.json'),JSON.stringify({entrypoint:'next/dist/server/lib/start-server.js'}));
          fs.writeFileSync(path.join(directory,'node/flushed-103'),'complete');
        }
        let message='';try {await generate(directory,{[target]:hash(original)})} catch(error) {message=error.message;}
        console.log(JSON.stringify({message}));
      } finally {fs.rmSync(directory,{recursive:true,force:true});}
    `);
    expect(result.message).toContain(
      missing === "browser-map"
        ? "Missing browser source map:"
        : missing === "worker-data"
          ? "Missing Playwright worker coverage: 103"
          : "Missing Next server coverage: 103",
    );
  });
}

test("static module linkage has no line obligation while executable exports and calls remain", () => {
  const result = probe(String.raw`
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import {generateDenominator} from './scripts/coverage-report.mjs';
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-linkage-'));
    try {
      const entries=[
        {url:'src/entry.ts',source:'import { value } from "./dep";\nimport "./side";\nexport { value };\nexport { value as other } from "./dep";\nexport function choose(flag: boolean | null) {\n  if (flag === true) return value;\n  return -1;\n}\nglobalThis.result = choose(true);\n'},
        {url:'src/dep.ts',source:'export const value = 7;\n'},
        {url:'src/side.ts',source:'globalThis.sideEffect = true;\n'},
        {url:'src/calls.ts',source:'export const initial = work();\nexport default work();\nimport("./dep");\nrequire("./dep");\n'},
        {url:'src/mixed.ts',source:'import { value } from "./dep"; work();\nexport { value }; work();\n'},
      ];
      const data=await generateDenominator(entries,directory);
      console.log(JSON.stringify(Object.fromEntries(data.files().map(key=>[key,data.fileCoverageFor(key).getLineCoverage()]))));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  `);
  expect(result["src/entry.ts"]).toEqual({ "5": 0, "6": 0, "7": 0, "9": 0 });
  expect(result["src/dep.ts"]).toEqual({ "1": 0 });
  expect(result["src/side.ts"]).toEqual({ "1": 0 });
  expect(result["src/calls.ts"]).toEqual({ "1": 0, "2": 0, "3": 0, "4": 0 });
  expect(result["src/mixed.ts"]).toEqual({ "1": 0, "2": 0 });
});

for (const preflight of ["missing-base", "invalid-base"]) {
  test(`coverage ${preflight} preflight replaces a previous passed status`, () => {
    const result = probe(String.raw`
      import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
      import {spawnSync} from 'node:child_process';
      const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-preflight-'));
      try {
        fs.mkdirSync(path.join(directory,'coverage'));
        fs.writeFileSync(path.join(directory,'coverage/latest.json'),JSON.stringify({status:'passed',runId:'old'}));
        fs.copyFileSync('scripts/run-coverage.mjs',path.join(directory,'run-coverage.mjs'));
        fs.writeFileSync(path.join(directory,'coverage-report.mjs'),'export const root='+JSON.stringify(directory)+'; export const hash=()=>""; export const inventory=()=>[]; export const generate=()=>{throw Error("Unexpected coverage run")}; export const generateDenominator=()=>{}; export const validateCaptureManifest=()=>{}; export const validateCoveragePlan=()=>{}; export const validateCoverageShard=()=>{}; export const mergeCoverageReports=()=>{}; export const createCoveragePlan=()=>{}; export const boundedCoverageWorkers=()=>2;');
        const setup=spawnSync('git',['init','--quiet',directory]);if(setup.status!==0)throw Error('Fixture Git initialization failed');
        const env={...process.env,NODE_OPTIONS:'',NODE_V8_COVERAGE:''};
        if(${JSON.stringify(preflight)}==='missing-base')delete env.COVERAGE_BASE_REF;else env.COVERAGE_BASE_REF='missing-coverage-base-reference';
        const run=spawnSync(process.execPath,[path.join(directory,'run-coverage.mjs')],{cwd:directory,env,encoding:'utf8'});
        console.log(JSON.stringify({exit:run.status,latest:JSON.parse(fs.readFileSync(path.join(directory,'coverage/latest.json')))}));
      } finally {fs.rmSync(directory,{recursive:true,force:true});}
    `);
    expect(result.exit).toBe(1);
    expect(result.latest.status).toBe("preflight-failed");
    expect(result.latest.runId).not.toBe("old");
    expect(result.latest.error).toContain(
      preflight === "missing-base"
        ? "COVERAGE_BASE_REF is required"
        : "Cannot resolve coverage revision:",
    );
  });
}

test("coverage manifest requires every discovered test to pass across all projects", () => {
  const result = probe(String.raw`
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import {validateCaptureManifest} from './scripts/coverage-report.mjs';
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-manifest-'));
    try {
      const projects=['isolated','http','chromium','mobile-chromium'];
      const report={config:{projects:projects.map(name=>({name}))},errors:[],suites:[{specs:projects.map(projectName=>({id:projectName,tests:[{projectName,expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}))}]};
      const discovery=structuredClone(report);
      fs.mkdirSync(path.join(directory,'browser'));
      for(const id of projects.slice(2))fs.writeFileSync(path.join(directory,'browser',id+'.json'),JSON.stringify({testId:id}));
      const check=value=>{try{validateCaptureManifest(directory,value,discovery);return true}catch{return false}};
      const valid=check(report);
      const rejected=[];
      for(const project of projects)for(const status of ['skipped','failed','timedOut','interrupted']){
        const invalid=structuredClone(report);const item=invalid.suites[0].specs.find(spec=>spec.id===project).tests[0];
        item.results=[{status}];if(status==='skipped')item.expectedStatus='skipped';
        rejected.push(!check(invalid));
      }
      for(const mode of ['missing-result','expected-failure','missing-test','missing-project','report-error','duplicate-test']){
        const invalid=structuredClone(report);const item=invalid.suites[0].specs[0].tests[0];
        if(mode==='missing-result')item.results=[];
        if(mode==='expected-failure'){item.expectedStatus='failed';item.results=[{status:'failed'}]}
        if(mode==='missing-test')invalid.suites[0].specs.shift();
        if(mode==='missing-project')invalid.config.projects.shift();
        if(mode==='report-error')invalid.errors.push({message:'collection failed'});
        if(mode==='duplicate-test')invalid.suites[0].specs.push(invalid.suites[0].specs[0]);
        rejected.push(!check(invalid));
      }
      const skipped=structuredClone(report);
      skipped.suites[0].specs[2].tests[0]={projectName:'chromium',expectedStatus:'skipped',status:'skipped',results:[]};
      fs.unlinkSync(path.join(directory,'browser/chromium.json'));
      rejected.push(!check(skipped));
      console.log(JSON.stringify({valid,rejected}));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  `);
  expect(result.valid).toBe(true);
  expect(result.rejected).toEqual(Array(23).fill(true));
});

test("incremental V8 captures require complete matching source and valid offsets", () => {
  const result = probe(String.raw`
    import {selectCompleteEntries} from './scripts/coverage-report.mjs';
    const source='function value(){return 1;}';
    const complete={url:'src/value.ts',source,functions:[{ranges:[{startOffset:0,endOffset:source.length,count:1}]}]};
    const fragment={...complete,functions:[{ranges:[{startOffset:1,endOffset:source.length-1,count:1}]}]};
    const cases=[[fragment],[complete,{...fragment,source:source+' '}],...[{startOffset:-1},{endOffset:source.length+1},{startOffset:1.5},{count:-1}].map(change=>[complete,{...fragment,functions:[{ranges:[{...fragment.functions[0].ranges[0],...change}]}]}])];
    console.log(JSON.stringify(cases.map(entries=>{try{selectCompleteEntries(entries);return false}catch{return true}})));
  `);
  expect(result).toEqual(Array(6).fill(true));
});
