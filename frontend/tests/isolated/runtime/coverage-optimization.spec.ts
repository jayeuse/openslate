import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

test("coverage workers stay bounded while leaving capacity for the host", () => {
  const result = probe(String.raw`
    import {boundedCoverageWorkers} from './scripts/coverage-report.mjs';
    console.log(JSON.stringify([0,1,2,3,4,5,8,32].map(value => boundedCoverageWorkers(value))));
  `);

  expect(result).toEqual([1, 1, 1, 2, 3, 4, 4, 4]);
});

test("coverage mode disables raw trace and video recording", () => {
  const config = readFileSync("playwright.config.ts", "utf8");
  expect(config).toMatch(/trace:\s+isCoverage\s+\?\s+"off"/);
  expect(config).toMatch(/video:\s+"off"/);
});

test("coverage plan CLI emits the PR profile with named parts", () => {
  const result = probe(String.raw`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import {spawnSync} from 'node:child_process';
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-plan-cli-'));
    try {
      const output=path.join(directory,'plan.json');
      const run=spawnSync(process.execPath,['scripts/run-coverage.mjs','--plan','--profile=pr','--output='+output],{
        cwd:process.cwd(),encoding:'utf8',env:{...process.env,COVERAGE_BASE_REF:'HEAD',NODE_OPTIONS:'',NODE_V8_COVERAGE:''},
      });
      if(run.status!==0)throw Error(run.stderr || run.stdout);
      const plan=JSON.parse(fs.readFileSync(output,'utf8'));
      console.log(JSON.stringify({
        version:plan.version,
        profile:plan.profile,
        parts:plan.parts.map(part=>({id:part.id,projects:part.projects,tests:part.tests.length})),
        projects:plan.projects,
        tests:plan.tests.length,
        assigned:plan.parts.flatMap(part=>part.tests).length,
        sources:plan.sourceInventory.length,
      }));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  `);

  expect(result.version).toBe(2);
  expect(result.profile).toBe("pr");
  expect(result.projects).toEqual(["chromium", "http", "isolated"]);
  expect(result.parts.map((part: { id: string }) => part.id)).toEqual([
    "core",
    "chromium-1",
    "chromium-2",
    "chromium-3",
  ]);
  expect(result.parts[0].projects.sort()).toEqual(["http", "isolated"]);
  expect(
    result.parts
      .slice(1)
      .every(
        (part: { projects: string[] }) => part.projects.join() === "chromium",
      ),
  ).toBe(true);
  expect(result.assigned).toBe(result.tests);
  expect(result.sources).toBeGreaterThan(0);
});

test("coverage CLI exposes explicit PR part and timing modes", () => {
  const result = probe(String.raw`
    import {parseCoverageArguments} from './scripts/run-coverage.mjs';
    const parsed=[
      parseCoverageArguments(['--plan','--profile=pr','--timings=timings.json','--output=plan.json']),
      parseCoverageArguments(['--profile=pr','--part=chromium-2','--plan=plan.json','--timing-output=timings.json','--output=part']),
      parseCoverageArguments(['--merge','--profile=pr','--plan=plan.json','--parts=parts','--output=merged']),
    ];
    let invalid='';try {parseCoverageArguments(['--part=chromium-4','--plan=plan.json'])} catch(error) {invalid=error.message;}
    console.log(JSON.stringify({parsed,invalid}));
  `);

  expect(result.parsed).toEqual([
    {
      mode: "plan",
      profile: "pr",
      planPath: null,
      outputPath: "plan.json",
      partsPath: null,
      part: null,
      timingsPath: "timings.json",
      timingOutputPath: null,
    },
    {
      mode: "run",
      profile: "pr",
      planPath: "plan.json",
      outputPath: "part",
      partsPath: null,
      part: "chromium-2",
      timingsPath: null,
      timingOutputPath: "timings.json",
    },
    {
      mode: "merge",
      profile: "pr",
      planPath: "plan.json",
      outputPath: "merged",
      partsPath: "parts",
      part: null,
      timingsPath: null,
      timingOutputPath: null,
    },
  ]);
  expect(result.invalid).toContain("core or chromium-1 through chromium-3");
});

test("coverage parts use deterministic longest-processing-time balancing and conservative new-test weights", () => {
  const result = probe(String.raw`
    import {createCoverageParts,DEFAULT_NEW_TEST_DURATION_MS,normalizeDurationProfile} from './scripts/coverage-report.mjs';
    const tests=[
      {projectName:'isolated',id:'isolated',file:'isolated/test.spec.ts',line:1},
      {projectName:'http',id:'http',file:'http/test.spec.ts',line:1},
      ...['a','b','c','d','e','f'].map((id,index)=>({projectName:'chromium',id,file:'browser/test.spec.ts',line:index+1})),
    ];
    const parts=createCoverageParts(tests,normalizeDurationProfile({version:1,tests:[
      {projectName:'chromium',id:'a',durationMs:90_000},
      {projectName:'chromium',id:'b',durationMs:80_000},
      {projectName:'chromium',id:'c',durationMs:70_000},
      {projectName:'chromium',id:'d',durationMs:60_000},
      {projectName:'chromium',id:'e',durationMs:50_000},
    ]}));
    console.log(JSON.stringify({
      ids:parts.slice(1).map(part=>part.tests.map(test=>test.id)),
      durations:parts.slice(1).map(part=>part.estimatedDurationMs),
      newWeight:parts.slice(1).flatMap(part=>part.tests).find(test=>test.id==='f').durationMs,
      sources:parts.slice(1).flatMap(part=>part.tests).map(test=>test.durationSource),
    }));
  `);

  expect(result.ids).toEqual([
    ["a", "e"],
    ["b", "c"],
    ["d", "f"],
  ]);
  expect(result.durations).toEqual([140_000, 150_000, 140_000]);
  expect(result.newWeight).toBe(80_000);
  expect(result.sources).toEqual([
    "historical",
    "historical",
    "historical",
    "historical",
    "historical",
    "conservative-default",
  ]);
});

test("coverage planning fails closed when historical part loads exceed 15 percent", () => {
  const result = probe(String.raw`
    import {createCoverageParts} from './scripts/coverage-report.mjs';
    const tests=[
      {projectName:'isolated',id:'isolated',file:'isolated/test.spec.ts',line:1},
      {projectName:'http',id:'http',file:'http/test.spec.ts',line:1},
      ...['slow','a','b'].map((id,index)=>({projectName:'chromium',id,file:'browser/test.spec.ts',line:index+1})),
    ];
    let error='';
    try {
      createCoverageParts(tests,{version:1,tests:[
        {projectName:'chromium',id:'slow',durationMs:100_000},
        {projectName:'chromium',id:'a',durationMs:10_000},
        {projectName:'chromium',id:'b',durationMs:10_000},
      ]});
    } catch (caught) { error=caught.message; }
    console.log(JSON.stringify({error}));
  `);

  expect(result.error).toContain("imbalanced");
});

test("timing profiles keep a five-run history and report compact observations", () => {
  const result = probe(String.raw`
    import {collectCoverageDurations,updateDurationProfile} from './scripts/coverage-report.mjs';
    const report={config:{projects:[{name:'chromium'}]},errors:[],suites:[{specs:[
      {id:'one',file:'browser/test.spec.ts',line:4,tests:[{projectName:'chromium',results:[{duration:20,status:'passed'}]}]},
      {id:'two',file:'browser/test.spec.ts',line:8,tests:[{projectName:'chromium',results:[{duration:40,status:'passed'}]}]},
    ]}]};
    let profile={version:1,tests:[{projectName:'chromium',id:'one',samples:[1,2,3,4,5]}]};
    const observations=collectCoverageDurations(report);
    profile=updateDurationProfile(profile,observations);
    console.log(JSON.stringify({observations,profile}));
  `);

  expect(result.observations).toEqual([
    {
      projectName: "chromium",
      id: "one",
      samples: [20],
      durationMs: 20,
      file: "browser/test.spec.ts",
      line: 4,
    },
    {
      projectName: "chromium",
      id: "two",
      samples: [40],
      durationMs: 40,
      file: "browser/test.spec.ts",
      line: 8,
    },
  ]);
  expect(result.profile.tests).toEqual([
    {
      projectName: "chromium",
      id: "one",
      samples: [2, 3, 4, 5, 20],
      durationMs: 4,
      file: "browser/test.spec.ts",
      line: 4,
    },
    {
      projectName: "chromium",
      id: "two",
      samples: [40],
      durationMs: 40,
      file: "browser/test.spec.ts",
      line: 8,
    },
  ]);
  expect(result.profile.degradedRuns).toBe(0);
});

test("coverage merge accepts every named part and rejects retries", () => {
  const result = probe(String.raw`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import {createCoveragePlan,hash,mergeCoverageReports} from './scripts/coverage-report.mjs';
    const projects=['isolated','http','chromium'];
    const tests=projects.flatMap(projectName => [0,1,2].map(index => ({projectName,id:projectName+'-'+index,file:projectName+'/test.spec.ts',line:index+1})));
    const reportFor=(items, options={}) => ({
      config:{projects:projects.map(name=>({name}))}, errors:[],
      suites:[{specs:items.map(item=>({id:item.id,file:item.file,line:item.line,tests:[{
        projectName:item.projectName,
        expectedStatus:options.expectedStatus ?? 'passed',
        status:options.status ?? 'expected',
        results:options.results ?? [{status:'passed'}],
      }]}))}],
    });
    const discovery=reportFor(tests);
    const sources={'src/one.ts':hash('one'),'src/two.ts':hash('two')};
    const plan=createCoveragePlan({baseRevision:'base-revision',headRevision:'head-revision',sources,denominator:{'src/one.ts':[1,2],'src/two.ts':[1]},discovery,timingProfile:{version:1,tests:tests.filter(test=>test.projectName==='chromium').map(test=>({...test,durationMs:10}))}});
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-merge-'));
    const writePart=(part, hits, reportOverride=undefined) => {
      const directory=path.join(root,'part-'+part.id);fs.mkdirSync(path.join(directory,'report'),{recursive:true});
      fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({status:'passed',revision:'head-revision',baseRef:'base-revision',sources:plan.sources,part:{id:part.id},runtime:{browserCaptures:part.projects.includes('chromium')?1:0,nodeEntries:2,serverEntries:1,isolatedEntries:part.projects.includes('isolated')?1:0,sourceMapsValidated:true}}));
      fs.writeFileSync(path.join(directory,'tests.json'),JSON.stringify(reportOverride ?? reportFor(part.tests)));
      fs.writeFileSync(path.join(directory,'report','coverage-final.json'),JSON.stringify({
        'src/one.ts':{path:'src/one.ts',statementMap:{0:{start:{line:1,column:0},end:{line:1,column:1}},1:{start:{line:2,column:0},end:{line:2,column:1}}},s:{0:hits[0],1:hits[1]},fnMap:{},f:{},branchMap:{},b:{}},
        'src/two.ts':{path:'src/two.ts',statementMap:{0:{start:{line:1,column:0},end:{line:1,column:1}}},s:{0:hits[2]},fnMap:{},f:{},branchMap:{},b:{}},
      }));
      if(part.projects.includes('chromium'))for(const test of part.tests){fs.mkdirSync(path.join(directory,'browser'),{recursive:true});fs.writeFileSync(path.join(directory,'browser',test.id+'.json'),JSON.stringify({testId:test.id}));}
      return directory;
    };
    try {
      const directories=plan.parts.map((part,index)=>writePart(part,[index===0?1:0,index===1?1:0,index===2?1:0]));
      const output=path.join(root,'merged');
      const merged=mergeCoverageReports({plan,partDirectories:directories,outputDirectory:output});
      const retryReport=reportFor(plan.parts[0].tests,{results:[{status:'passed'},{status:'passed'}]});
      writePart(plan.parts[0],[1,0,0],retryReport);
      let retryError='';try {mergeCoverageReports({plan,partDirectories:directories,outputDirectory:path.join(root,'retry')});} catch(error) {retryError=error.message;}
      console.log(JSON.stringify({parts:merged.parts,files:merged.files,retryError}));
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  `);

  expect(result.parts).toBe(4);
  expect(result.files).toBe(2);
  expect(result.retryError).toContain("Retried");
});

test("coverage merge rejects a missing named part and missing browser capture", () => {
  const result = probe(String.raw`
    import {createCoveragePlan,hash,validateCoveragePart} from './scripts/coverage-report.mjs';
    const report={config:{projects:[{name:'isolated'},{name:'http'},{name:'chromium'}]},errors:[],suites:[{specs:[
      {id:'core',file:'isolated/test.spec.ts',line:1,tests:[{projectName:'isolated',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]},
      {id:'http',file:'http/test.spec.ts',line:1,tests:[{projectName:'http',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]},
      ...['browser-1','browser-2','browser-3'].map((id,index)=>({id,file:'browser/test.spec.ts',line:index+1,tests:[{projectName:'chromium',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]})),
    ]}]};
    const plan=createCoveragePlan({baseRevision:'base',headRevision:'head',sources:{'src/one.ts':hash('one')},denominator:{'src/one.ts':[1]},discovery:report});
    const partReport={...report,suites:[{specs:plan.parts[1].tests.map(test=>({id:test.id,file:test.file,line:test.line,tests:[{projectName:test.projectName,expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}))}]};
    let message='';try {validateCoveragePart(plan,partReport,'chromium-1','/tmp/openslate-missing-capture-'+Date.now());} catch(error) {message=error.message;}
    console.log(JSON.stringify({message,partIds:plan.parts.map(part=>part.id)}));
  `);

  expect(result.partIds).toEqual([
    "core",
    "chromium-1",
    "chromium-2",
    "chromium-3",
  ]);
  expect(result.message).toContain("Missing browser captures");
});

test("coverage merge CLI rejects a coherent plan that is stale for the checkout", () => {
  const result = probe(String.raw`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import {spawnSync} from 'node:child_process';
    import {createCoveragePlan,hash,inventory} from './scripts/coverage-report.mjs';
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-stale-plan-'));
    try {
      const sources=Object.fromEntries(inventory().map(source=>[source,hash(fs.readFileSync(source))]));
      const report={config:{projects:[{name:'isolated'},{name:'http'},{name:'chromium'}]},errors:[],suites:[{specs:[
        {id:'isolated-test',file:'isolated/test.spec.ts',line:1,tests:[{projectName:'isolated',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]},
        {id:'http-test',file:'http/test.spec.ts',line:1,tests:[{projectName:'http',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]},
        ...['browser-1','browser-2','browser-3'].map((id,index)=>({id,file:'browser/test.spec.ts',line:index+1,tests:[{projectName:'chromium',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]})),
      ]}]};
      const plan=createCoveragePlan({baseRevision:'base',headRevision:'stale-head',sources,denominator:Object.fromEntries(Object.keys(sources).map(source=>[source,[1]])),discovery:report});
      const planPath=path.join(directory,'plan.json');fs.writeFileSync(planPath,JSON.stringify(plan));
      const run=spawnSync(process.execPath,['scripts/run-coverage.mjs','--merge','--profile=pr','--plan='+planPath,'--parts='+directory,'--output='+path.join(directory,'merged')],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NODE_V8_COVERAGE:''}});
      console.log(JSON.stringify({status:run.status,output:(run.stderr||'')+(run.stdout||'')}));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  `);

  expect(result.status).toBe(1);
  expect(result.output).toContain("current checkout");
});
