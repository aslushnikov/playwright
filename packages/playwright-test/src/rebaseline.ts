/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import { types, parse, traverse } from './babelBundle';
import type { TestStep } from '../types/testReporter';

const supportedMatchers = new Set([
  'toBe',
  'toMatchSnapshot',
]);

export class RebaselineLog {
  _failedSteps: {
    step: TestStep,
    rebaselineInfo: any
  }[] = [];

  onStepEnd(step: TestStep, rebaselineInfo: any) {
    if (!step.error || !rebaselineInfo)
      return;
    this._failedSteps.push({ step, rebaselineInfo });
  }

  async save() {
    const result = [];
    const sourceCodesCache: Map<string, Promise<SourceCode>> = new Map();
    for (const { step, rebaselineInfo } of this._failedSteps) {
      if (!step.location)
        continue;
      const sourceCode = await SourceCode.read(step.location.file, sourceCodesCache);
      result.push({
        ...rebaselineInfo,
        file: sourceCode.filepath,
        offset: sourceCode.positionToOffset(step.location.line - 1, step.location.column - 1),
      });
    }
    await fs.promises.writeFile('./rebaseline.json', JSON.stringify(result, null, 2));
  }
}

export async function rebaselineCommand() {
  const sourceCodesCache = new Map();
  const rawRules = JSON.parse(await fs.promises.readFile('./rebaseline.json', 'utf8'));
  const rules = await Promise.all(rawRules.map(async (rawRule: any) => {
    const sourceCode = await SourceCode.read(rawRule.file, sourceCodesCache);
    return {
      matcherName: rawRule.matcherName,
      value: rawRule.value,
      file: rawRule.file,
      sourceCode,
      offset: sourceCode.liveOffset(rawRule.offset),
    };
  }));

  for (const rule of rules) {
    const matcher = rule.sourceCode.findMatcher(rule.matcherName, rule.offset.value);
    if (!matcher)
      throw new Error('failed to process');
    const newValue = JSON.stringify(rule.value);
    rule.sourceCode.replace(matcher.argStart.value, matcher.argEnd.value, newValue);
  }

  for (const code of await Promise.all([...sourceCodesCache.values()])) {
    console.log(`=====================`);
    console.log(code.filepath);
    console.log(`---------------------`);
    console.log(code.code);
    console.log(`=====================`);
  }
  return;
}

class LiveOffset {
  value: number;

  constructor(offset: number) {
    this.value = offset;
  }
}

export class SourceCode {
  filepath: string;
  code: string;
  _lineEndings: number[];
  _liveOffsets: LiveOffset[] = [];
  _hadChanges: boolean = false;

  _matchers?: {
    offset: LiveOffset,
    name: string,
    argStart?: LiveOffset,
    argEnd?: LiveOffset,
  }[];

  static async read(filepath: string, cache: Map<string, Promise<SourceCode>>|undefined = undefined) {
    let code = cache ? cache.get(filepath) : undefined;
    if (!code) {
      code = Promise.resolve().then(async () => {
        return new SourceCode(filepath, await fs.promises.readFile(filepath, 'utf8'));
      });
      if (cache)
        cache.set(filepath, code);
    }
    return code;
  }

  constructor(filepath: string, code: string) {
    this.filepath = filepath;
    this.code = code;
    this._lineEndings = [];
    for (let i = 0; i < code.length; ++i) {
      if (code[i] === '\n')
        this._lineEndings.push(i);
    }
  }

  findMatcher(name: string, offset: number) {
    const matchers = this._ensureMatchers();
    let l = 0, r = matchers.length;
    while (l < r) {
      const m = (l + r) >> 1;
      const val = matchers[m];
      if (val.offset.value < offset) {
        l = m + 1;
      } else if (val.offset.value > offset) {
        r = m;
      } else {
        return val.name === name ? val : undefined;
      }
    }
    return undefined;
  }

  _ensureMatchers() {
    if (this._matchers)
      return this._matchers;
    this._matchers = [];
    const ast = parse(this.code, {
      allowImportExportEverywhere: true,
      sourceFilename: this.filepath,
      plugins: [
        ['typescript', { dts: false }]
      ]
    });

    traverse(ast, {
      CallExpression: path => {
        const { node } = path;
        if (!types.isMemberExpression(node.callee) || !types.isIdentifier(node.callee.property) || !supportedMatchers.has(node.callee.property.name))
          return;
        if (node.arguments.length && !types.isLiteral(node.arguments[0]))
          return;
        const argument = node.arguments.length ? node.arguments[0] : undefined;
        this._matchers!.push({
          name: node.callee.property.name,
          offset: this.liveOffset(node.callee.property.start!),
          argStart: argument && argument.start ? this.liveOffset(argument.start) : undefined,
          argEnd: argument && argument.end ? this.liveOffset(argument.end) : undefined,
        });
      }
    });
    this._matchers.sort((m1, m2) => m1.offset.value - m2.offset.value);
    return this._matchers;
  }

  positionToOffset(lineNumber: number, columnNumber: number): number {
    return lineNumber === 0 ? columnNumber : this._lineEndings[lineNumber - 1] + 1 + columnNumber;
  }

  liveOffset(offset: number) {
    const live = new LiveOffset(offset);
    this._liveOffsets.push(live);
    return live;
  }

  replace(from: number, to: number, text: string) {
    this._hadChanges = true;
    const delta = - to + from + text.length;
    this.code = this.code.substring(0, from) + text + this.code.substring(to);
    for (const liveOffset of this._liveOffsets) {
      if (liveOffset.value <= from)
        continue;
      if (liveOffset.value >= to)
        liveOffset.value += delta;
      else 
        throw new Error('internal error: LiveOffset was removed due to edit operation');
    }
  }

  async save() {
    if (!this._hadChanges)
      return;
    await fs.promises.writeFile(this.filepath, this.code, 'utf8');
  }
}