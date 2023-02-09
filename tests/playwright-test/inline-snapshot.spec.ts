/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';
import { PNG } from 'playwright-core/lib/utilsBundle';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { test, expect, stripAnsi, createImage, paintBlackPixels } from './playwright-test-fixtures';
import { comparePNGs } from '../config/comparator';

test.describe.configure({ mode: 'parallel' });

test('should update toBe matcher', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'a.spec.js': `
      pwt.test('is a test', async ({ }) => {
        expect(1).toBe(2);
        expect('foo-1').toBe("qqq" /* trailing comment */);
        expect('foo-2').toBe(/* leading comment */{ foo: 'baz' });
        expect('foo-3').toBe({ 'foo': 'bar' });
        expect('foo-4').toBe({ ['foo']: 'bar' });
        expect.soft('foo-5').toBe([1
    ,2
              ,3]);
      });
    `
  }, { 'rebaseline-matchers': true });
  expect(result.exitCode).toBe(0);
  const source = fs.readFileSync(testInfo.outputPath('a.spec.js'), 'utf-8');
  expect(source).toContain('expect(1).toBe(1)');
  expect(source).toContain(`expect('foo-1').toBe("foo-1" /* trailing comment */)`);
  expect(source).toContain(`expect('foo-2').toBe(/* leading comment */"foo-2")`);
  expect(source).toContain(`expect('foo-3').toBe("foo-3")`);
  expect(source).toContain(`expect('foo-4').toBe("foo-4")`);
  expect(source).toContain(`expect.soft('foo-5').toBe("foo-5")`);
});

test('should work with expect.poll', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'a.spec.js': `
      pwt.test('is a test', async ({ }) => {
        await expect.poll(() => 4, { timeout: 1000 }).toBe(0);
      });
    `
  }, { 'rebaseline-matchers': true });
  expect(result.exitCode).toBe(0);
  const source = fs.readFileSync(testInfo.outputPath('a.spec.js'), 'utf-8');
  expect(source).toContain('toBe(4)');
});

test('should work with expect().toPass', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'a.spec.js': `
      pwt.test('is a test', async ({ }) => {
        await expect(() => {
          expect('foo').toBe('bar');
        }).toPass({ timeout: 1000 });
      });
    `
  }, { 'rebaseline-matchers': true });
  expect(result.exitCode).toBe(0);
  const source = fs.readFileSync(testInfo.outputPath('a.spec.js'), 'utf-8');
  expect(source).toContain('toBe("foo")');
});

test('should fill matchers when expectation is missing', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'a.spec.js': `
      pwt.test('is a test', async ({ }) => {
        expect(1).toBe();
        expect('foo').toBe();
      });
    `
  }, {});
  console.log();
  expect(result.exitCode).toBe(1);
  const source = fs.readFileSync(testInfo.outputPath('a.spec.js'), 'utf-8');
  expect(source).toContain('expect(1).toBe(1)');
  expect(source).toContain(`expect('foo').toBe("foo")`);
});

test('should bail out if expected value has identifier', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'a.spec.js': `
      pwt.test('should fail', async ({ }) => {
        const foo = 2;
        expect(1).toBe(foo); // line 8
        expect(1).toBe({ foo }); // line 9
        expect(1).toBe({ [foo]: 1 }); // line 10
      });
      pwt.test('should fail for complicated objects', async ({ }) => {
        const foo = 2;
        expect(1).toBe({ // line 14
          foo: {
            bar: [1,2,3,{
              baz: Math.round(foo),
            }],
          }
        });
      });
    `
  }, { 'rebaseline-matchers': true });
  expect(result.exitCode).toBe(1);
  // When running with -u, the tests will be marked as "passed".
  expect(result.passed).toBe(2);
  expect(result.failed).toBe(0);
  const source = fs.readFileSync(testInfo.outputPath('a.spec.js'), 'utf-8');
  expect(result.output).toContain(`Error: Failed to perform the following rebaselines:`);
  expect(result.output).toContain(`${testInfo.outputPath('a.spec.js')}:8`);
  expect(result.output).toContain(`${testInfo.outputPath('a.spec.js')}:9`);
  expect(result.output).toContain(`${testInfo.outputPath('a.spec.js')}:10`);
  expect(result.output).toContain(`${testInfo.outputPath('a.spec.js')}:14`);
});
