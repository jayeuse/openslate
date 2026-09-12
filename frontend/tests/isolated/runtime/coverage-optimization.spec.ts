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
  expect(config).toContain(
    'trace: process.env.FRONTEND_COVERAGE === "1" ? "off" : "on-first-retry"',
  );
  expect(config).toContain(
    'video: process.env.FRONTEND_COVERAGE === "1" ? "off" : "retain-on-failure"',
  );
});

test("coverage plan CLI discovers one complete deterministic three-shard plan", () => {
  const result = probe(String.raw`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import {spawnSync} from 'node:child_process';
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-plan-cli-'));
    try {
      const output=path.join(directory,'plan.json');
      const run=spawnSync(process.execPath,['scripts/run-coverage.mjs','--plan','--output='+output],{
        cwd:process.cwd(),encoding:'utf8',env:{...process.env,COVERAGE_BASE_REF:'HEAD',NODE_OPTIONS:'',NODE_V8_COVERAGE:''},
      });
      if(run.status!==0)throw Error(run.stderr || run.stdout);
      const plan=JSON.parse(fs.readFileSync(output,'utf8'));
      console.log(JSON.stringify({
        shards:plan.shards.length,
        tests:plan.tests.length,
        assigned:plan.shards.flatMap(shard=>shard.tests).length,
        sources:plan.sourceInventory.length,
      }));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  `);

  expect(result.shards).toBe(3);
  expect(result.tests).toBeGreaterThan(0);
  expect(result.assigned).toBe(result.tests);
  expect(result.sources).toBeGreaterThan(0);
});

test("coverage CLI exposes explicit plan, shard, and merge modes", () => {
  const result = probe(String.raw`
    import {parseCoverageArguments} from './scripts/run-coverage.mjs';
    const parsed=[
      parseCoverageArguments([]),
      parseCoverageArguments(['--plan','--output=plan.json']),
      parseCoverageArguments(['--shard=2/3','--plan=plan.json','--output=shard']),
      parseCoverageArguments(['--merge','--plan=plan.json','--shards=shards','--output=merged']),
    ];
    let invalid='';try {parseCoverageArguments(['--shard=0/3'])} catch(error) {invalid=error.message;}
    console.log(JSON.stringify({parsed,invalid}));
  `);

  expect(result.parsed).toEqual([
    {
      mode: "run",
      planPath: null,
      outputPath: null,
      shardsPath: null,
      shard: null,
    },
    {
      mode: "plan",
      planPath: null,
      outputPath: "plan.json",
      shardsPath: null,
      shard: null,
    },
    {
      mode: "run",
      planPath: "plan.json",
      outputPath: "shard",
      shardsPath: null,
      shard: { index: 2, count: 3 },
    },
    {
      mode: "merge",
      planPath: "plan.json",
      outputPath: "merged",
      shardsPath: "shards",
      shard: null,
    },
  ]);
  expect(result.invalid).toContain("valid 1-based index");
});

test("coverage plans preserve deterministic shard assignments and merge compact reports", () => {
  const result = probe(String.raw`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import {
      createCoveragePlan,
      hash,
      mergeCoverageReports,
      validateCoveragePlan,
    } from './scripts/coverage-report.mjs';

    const projects=['isolated','http','chromium','mobile-chromium'];
    const tests=projects.flatMap(projectName => [0,1,2].map(index => ({projectName,id:projectName+'-'+index})));
    const reportFor=(items, options={}) => ({
      config:{projects:projects.map(name=>({name}))}, errors:[],
      suites:[{specs:items.map(({projectName,id})=>({id,tests:[{
        projectName,
        expectedStatus:options.expectedStatus ?? 'passed',
        status:options.status ?? 'expected',
        results:options.results ?? [{status:'passed'}],
      }]}))}],
    });
    const discovery=reportFor(tests);
    const shardDiscoveries=[0,1,2].map(index => reportFor(tests.filter((_,testIndex)=>testIndex%3===index)));
    const sources={'src/one.ts':hash('one'),'src/two.ts':hash('two')};
    const plan=createCoveragePlan({
      baseRevision:'base-revision',
      headRevision:'head-revision',
      sources,
      denominator:{'src/one.ts':[1,2],'src/two.ts':[1]},
      discovery,
      shardDiscoveries,
    });
    validateCoveragePlan(plan);

    const root=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-merge-'));
    const writeShard=(index, hits, metadataOverrides={}, reportOverride=undefined) => {
      const directory=path.join(root,'shard-'+index+'-of-3');
      fs.mkdirSync(path.join(directory,'report'),{recursive:true});
      fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({
        status:'passed', revision:'head-revision', baseRef:'base-revision', sources,
        shard:{index,count:3}, runtime:{browserCaptures:1,nodeEntries:2,serverEntries:1,isolatedEntries:1,sourceMapsValidated:true},
        ...metadataOverrides,
      }));
      fs.writeFileSync(path.join(directory,'tests.json'),JSON.stringify(reportOverride ?? reportFor(plan.shards[index-1].tests)));
      fs.writeFileSync(path.join(directory,'report','coverage-final.json'),JSON.stringify({
        'src/one.ts':{path:'src/one.ts',statementMap:{0:{start:{line:1,column:0},end:{line:1,column:1}},1:{start:{line:2,column:0},end:{line:2,column:1}}},s:{0:hits[0],1:hits[1]},fnMap:{},f:{},branchMap:{},b:{}},
        'src/two.ts':{path:'src/two.ts',statementMap:{0:{start:{line:1,column:0},end:{line:1,column:1}}},s:{0:hits[2]},fnMap:{},f:{},branchMap:{},b:{}},
      }));
    };
    try {
      writeShard(1,[1,0,0]);
      writeShard(2,[0,1,0]);
      writeShard(3,[0,0,1]);
      const output=path.join(root,'merged');
      const merged=mergeCoverageReports({plan,shardDirectories:[
        path.join(root,'shard-1-of-3'),path.join(root,'shard-2-of-3'),path.join(root,'shard-3-of-3'),
      ],outputDirectory:output});
      const report=JSON.parse(fs.readFileSync(path.join(output,'coverage-final.json')));
      const retryReport=reportFor(plan.shards[0].tests,{results:[{status:'passed'},{status:'passed'}]});
      writeShard(1,[1,0,0],{},retryReport);
      let retryError='';try {mergeCoverageReports({plan,shardDirectories:[
        path.join(root,'shard-1-of-3'),path.join(root,'shard-2-of-3'),path.join(root,'shard-3-of-3'),
      ],outputDirectory:path.join(root,'retry')});} catch(error) {retryError=error.message;}
      console.log(JSON.stringify({
        shards:plan.shards.map(shard=>shard.tests),
        merged,
        lines:[report['src/one.ts'].s,report['src/two.ts'].s],
        retryError,
      }));
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  `);

  expect(result.shards).toHaveLength(3);
  expect(
    new Set(
      result.shards
        .flat()
        .map(
          (item: { projectName: string; id: string }) =>
            `${item.projectName}/${item.id}`,
        ),
    ).size,
  ).toBe(12);
  expect(result.merged).toMatchObject({ shards: 3, files: 2 });
  expect(result.lines).toEqual([{ "0": 1, "1": 1 }, { "0": 1 }]);
  expect(result.retryError).toContain("Retried");
});

test("coverage merge rejects a denominator that shrinks in one shard", () => {
  const result = probe(String.raw`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import {createCoveragePlan,hash,mergeCoverageReports} from './scripts/coverage-report.mjs';
    const projects=['isolated'];
    const testReport={config:{projects:[{name:'isolated'}]},errors:[],suites:[{specs:[{id:'one',tests:[{projectName:'isolated',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}]}]};
    const sources={'src/one.ts':hash('one')};
    const plan=createCoveragePlan({baseRevision:'base',headRevision:'head',sources,denominator:{'src/one.ts':[1,2]},discovery:testReport,shardDiscoveries:[testReport]});
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-denominator-'));const directory=path.join(root,'shard-1-of-1');
    fs.mkdirSync(path.join(directory,'report'),{recursive:true});
    fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({status:'passed',revision:'head',baseRef:'base',sources,shard:{index:1,count:1},runtime:{browserCaptures:1,nodeEntries:1,serverEntries:1,isolatedEntries:1,sourceMapsValidated:true}}));
    fs.writeFileSync(path.join(directory,'tests.json'),JSON.stringify(testReport));
    fs.writeFileSync(path.join(directory,'report','coverage-final.json'),JSON.stringify({'src/one.ts':{path:'src/one.ts',statementMap:{0:{start:{line:1,column:0},end:{line:1,column:1}}},s:{0:1},fnMap:{},f:{},branchMap:{},b:{}}}));
    let message='';try {mergeCoverageReports({plan,shardDirectories:[directory],outputDirectory:path.join(root,'merged')});} catch(error) {message=error.message;}
    fs.rmSync(root,{recursive:true,force:true});
    console.log(JSON.stringify({message}));
  `);

  expect(result.message).toContain("denominator");
});

test("coverage runtime requirements follow the projects assigned to each shard", () => {
  const result = probe(String.raw`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import {createCoveragePlan,hash,mergeCoverageReports} from './scripts/coverage-report.mjs';
    const projects=['isolated','chromium'];
    const reportFor=items=>({config:{projects:projects.map(name=>({name}))},errors:[],suites:[{specs:items.map(({projectName,id})=>({id,tests:[{projectName,expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}))}]});
    const discovery=reportFor([{projectName:'isolated',id:'isolated-test'},{projectName:'chromium',id:'browser-test'}]);
    const plan=createCoveragePlan({baseRevision:'base',headRevision:'head',sources:{'src/one.ts':hash('one')},denominator:{'src/one.ts':[1]},discovery,shardDiscoveries:[
      reportFor([{projectName:'isolated',id:'isolated-test'}]),
      reportFor([{projectName:'chromium',id:'browser-test'}]),
    ]});
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-runtime-'));
    const writeShard=(index,runtime)=>{
      const directory=path.join(root,'shard-'+index+'-of-2');fs.mkdirSync(path.join(directory,'report'),{recursive:true});
      fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({status:'passed',revision:'head',baseRef:'base',sources:plan.sources,shard:{index,count:2},runtime:{...runtime,sourceMapsValidated:true}}));
      fs.writeFileSync(path.join(directory,'tests.json'),JSON.stringify(plan.shards[index-1].tests.length===1?reportFor(plan.shards[index-1].tests):discovery));
      fs.writeFileSync(path.join(directory,'report','coverage-final.json'),JSON.stringify({'src/one.ts':{path:'src/one.ts',statementMap:{0:{start:{line:1,column:0},end:{line:1,column:1}}},s:{0:1},fnMap:{},f:{},branchMap:{},b:{}}}));
      if(index===2){fs.mkdirSync(path.join(directory,'browser'));fs.writeFileSync(path.join(directory,'browser','browser.json'),JSON.stringify({testId:'browser-test'}));}
      return directory;
    };
    try {
      const directories=[writeShard(1,{browserCaptures:0,nodeEntries:1,serverEntries:0,isolatedEntries:1}),writeShard(2,{browserCaptures:1,nodeEntries:1,serverEntries:1,isolatedEntries:0})];
      let message='';try {mergeCoverageReports({plan,shardDirectories:directories,outputDirectory:path.join(root,'merged')});} catch(error) {message=error.message;}
      console.log(JSON.stringify({message}));
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  `);

  expect(result.message).toBe("");
});

test("coverage shard validation rejects a missing capture for an assigned browser test", () => {
  const result = probe(String.raw`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import {createCoveragePlan,hash,validateCoverageShard} from './scripts/coverage-report.mjs';
    const report={config:{projects:[{name:'chromium'}]},errors:[],suites:[{specs:[{id:'browser-test',tests:[{projectName:'chromium',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}]}]};
    const plan=createCoveragePlan({baseRevision:'base',headRevision:'head',sources:{'src/one.ts':hash('one')},denominator:{'src/one.ts':[1]},discovery:report,shardDiscoveries:[report]});
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openslate-coverage-browser-capture-'));
    let message='';try {validateCoverageShard(plan,report,1,directory);} catch(error) {message=error.message;} finally {fs.rmSync(directory,{recursive:true,force:true});}
    console.log(JSON.stringify({message}));
  `);

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
      const report={config:{projects:[{name:'isolated'}]},errors:[],suites:[{specs:[{id:'isolated-test',tests:[{projectName:'isolated',expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}]}]};
      const plan=createCoveragePlan({baseRevision:'base',headRevision:'stale-head',sources,denominator:Object.fromEntries(Object.keys(sources).map(source=>[source,[1]])),discovery:report,shardDiscoveries:[report]});
      const planPath=path.join(directory,'plan.json');fs.writeFileSync(planPath,JSON.stringify(plan));
      const run=spawnSync(process.execPath,['scripts/run-coverage.mjs','--merge','--plan='+planPath,'--shards='+directory,'--output='+path.join(directory,'merged')],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NODE_V8_COVERAGE:''}});
      console.log(JSON.stringify({status:run.status,output:(run.stderr||'')+(run.stdout||'')}));
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  `);

  expect(result.status).toBe(1);
  expect(result.output).toContain("current checkout");
});
