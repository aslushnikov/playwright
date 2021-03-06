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

import * as actions from './recorder/recorderActions';
import type * as channels from '../../protocol/channels';
import { CodeGenerator, ActionInContext } from './recorder/codeGenerator';
import { describeFrame, toClickOptions, toModifiers } from './recorder/utils';
import { Page } from '../page';
import { Frame } from '../frames';
import { BrowserContext } from '../browserContext';
import { LanguageGenerator } from './recorder/language';
import { JavaScriptLanguageGenerator } from './recorder/javascript';
import { CSharpLanguageGenerator } from './recorder/csharp';
import { PythonLanguageGenerator } from './recorder/python';
import * as recorderSource from '../../generated/recorderSource';
import * as consoleApiSource from '../../generated/consoleApiSource';
import { BufferedOutput, FileOutput, OutputMultiplexer, RecorderOutput } from './recorder/outputs';
import { EventData, Mode, RecorderApp } from './recorder/recorderApp';
import { internalCallMetadata } from '../instrumentation';

type BindingSource = { frame: Frame, page: Page };

const symbol = Symbol('RecorderSupplement');

export class RecorderSupplement {
  private _generator: CodeGenerator;
  private _pageAliases = new Map<Page, string>();
  private _lastPopupOrdinal = 0;
  private _lastDialogOrdinal = 0;
  private _timers = new Set<NodeJS.Timeout>();
  private _context: BrowserContext;
  private _resumeCallback: (() => void) | null = null;
  private _mode: Mode;
  private _paused = false;
  private _output: OutputMultiplexer;
  private _bufferedOutput: BufferedOutput;
  private _recorderApp: RecorderApp | null = null;
  private _highlighterType: string;
  private _params: channels.BrowserContextRecorderSupplementEnableParams;

  static getOrCreate(context: BrowserContext, params: channels.BrowserContextRecorderSupplementEnableParams = {}): Promise<RecorderSupplement> {
    let recorderPromise = (context as any)[symbol] as Promise<RecorderSupplement>;
    if (!recorderPromise) {
      const recorder = new RecorderSupplement(context, params);
      recorderPromise = recorder.install().then(() => recorder);
      (context as any)[symbol] = recorderPromise;
    }
    return recorderPromise;
  }

  constructor(context: BrowserContext, params: channels.BrowserContextRecorderSupplementEnableParams) {
    this._context = context;
    this._params = params;
    this._mode = params.startRecording ? 'recording' : 'none';
    let languageGenerator: LanguageGenerator;
    const language = params.language || context._options.sdkLanguage;
    switch (language) {
      case 'javascript': languageGenerator = new JavaScriptLanguageGenerator(); break;
      case 'csharp': languageGenerator = new CSharpLanguageGenerator(); break;
      case 'python':
      case 'python-async': languageGenerator = new PythonLanguageGenerator(params.language === 'python-async'); break;
      default: throw new Error(`Invalid target: '${params.language}'`);
    }
    let highlighterType = language;
    if (highlighterType === 'python-async')
      highlighterType = 'python';

    const outputs: RecorderOutput[] = [];
    this._highlighterType = highlighterType;
    this._bufferedOutput = new BufferedOutput(async text => {
      if (this._recorderApp)
        this._recorderApp.setSource(text, highlighterType);
    });
    outputs.push(this._bufferedOutput);
    if (params.outputFile)
      outputs.push(new FileOutput(params.outputFile));
    this._output = new OutputMultiplexer(outputs);
    this._output.setEnabled(!!params.startRecording);
    context.on(BrowserContext.Events.BeforeClose, () => this._output.flush());

    const generator = new CodeGenerator(context._browser.options.name, !!params.startRecording, params.launchOptions || {}, params.contextOptions || {}, this._output, languageGenerator, params.device, params.saveStorage);
    this._generator = generator;
  }

  async install() {
    const recorderApp = await RecorderApp.open(this._context);
    this._recorderApp = recorderApp;
    recorderApp.once('close', () => {
      this._recorderApp = null;
    });
    recorderApp.on('event', (data: EventData) => {
      if (data.event === 'setMode') {
        this._mode = data.params.mode;
        recorderApp.setMode(this._mode);
        this._output.setEnabled(this._mode === 'recording');
        if (this._mode !== 'none')
          this._context.pages()[0].bringToFront().catch(() => {});
        return;
      }
      if (data.event === 'resume') {
        this._resume();
        return;
      }
      if (data.event === 'clear') {
        this._clearScript();
        return;
      }
    });

    await Promise.all([
      recorderApp.setMode(this._mode),
      recorderApp.setPaused(this._paused),
      recorderApp.setSource(this._bufferedOutput.buffer(), this._highlighterType)
    ]);

    this._context.on(BrowserContext.Events.Page, page => this._onPage(page));
    for (const page of this._context.pages())
      this._onPage(page);

    this._context.once(BrowserContext.Events.Close, () => {
      for (const timer of this._timers)
        clearTimeout(timer);
      this._timers.clear();
      recorderApp.close().catch(() => {});
    });

    // Input actions that potentially lead to navigation are intercepted on the page and are
    // performed by the Playwright.
    await this._context.exposeBinding('_playwrightRecorderPerformAction', false,
        (source: BindingSource, action: actions.Action) => this._performAction(source.frame, action));

    // Other non-essential actions are simply being recorded.
    await this._context.exposeBinding('_playwrightRecorderRecordAction', false,
        (source: BindingSource, action: actions.Action) => this._recordAction(source.frame, action));

    // Commits last action so that no further signals are added to it.
    await this._context.exposeBinding('_playwrightRecorderCommitAction', false,
        (source: BindingSource, action: actions.Action) => this._generator.commitLastAction());

    await this._context.exposeBinding('_playwrightRecorderState', false, () => {
      return { mode: this._mode };
    });

    await this._context.exposeBinding('_playwrightResume', false, () => {
      this._resume().catch(() => {});
    });

    await this._context.extendInjectedScript(recorderSource.source);
    await this._context.extendInjectedScript(consoleApiSource.source);

    (this._context as any).recorderAppForTest = recorderApp;
  }

  async pause() {
    this._paused = true;
    this._recorderApp!.setPaused(true);
    return new Promise<void>(f => this._resumeCallback = f);
  }

  private async _resume() {
    if (this._resumeCallback)
      this._resumeCallback();
    this._resumeCallback = null;
    this._paused = false;
    if (this._recorderApp)
      this._recorderApp.setPaused(this._paused);
  }

  private async _onPage(page: Page) {
    // First page is called page, others are called popup1, popup2, etc.
    const frame = page.mainFrame();
    page.on('close', () => {
      this._pageAliases.delete(page);
      this._generator.addAction({
        pageAlias,
        ...describeFrame(page.mainFrame()),
        committed: true,
        action: {
          name: 'closePage',
          signals: [],
        }
      });
    });
    frame.on(Frame.Events.Navigation, () => this._onFrameNavigated(frame, page));
    page.on(Page.Events.Download, () => this._onDownload(page));
    page.on(Page.Events.Popup, popup => this._onPopup(page, popup));
    page.on(Page.Events.Dialog, () => this._onDialog(page));
    const suffix = this._pageAliases.size ? String(++this._lastPopupOrdinal) : '';
    const pageAlias = 'page' + suffix;
    this._pageAliases.set(page, pageAlias);

    const isPopup = !!await page.opener();
    // Could happen due to the await above.
    if (page.isClosed())
      return;
    if (!isPopup) {
      this._generator.addAction({
        pageAlias,
        ...describeFrame(page.mainFrame()),
        committed: true,
        action: {
          name: 'openPage',
          url: page.mainFrame().url(),
          signals: [],
        }
      });
    }
  }

  private _clearScript(): void {
    this._bufferedOutput.clear();
    this._generator.restart();
    if (!!this._params.startRecording) {
      for (const page of this._context.pages())
        this._onFrameNavigated(page.mainFrame(), page);
    }
  }

  private async _performAction(frame: Frame, action: actions.Action) {
    const page = frame._page;
    const actionInContext: ActionInContext = {
      pageAlias: this._pageAliases.get(page)!,
      ...describeFrame(frame),
      action
    };
    this._generator.willPerformAction(actionInContext);
    const noCallMetadata = internalCallMetadata();
    try {
      const kActionTimeout = 5000;
      if (action.name === 'click') {
        const { options } = toClickOptions(action);
        await frame.click(noCallMetadata, action.selector, { ...options, timeout: kActionTimeout });
      }
      if (action.name === 'press') {
        const modifiers = toModifiers(action.modifiers);
        const shortcut = [...modifiers, action.key].join('+');
        await frame.press(noCallMetadata, action.selector, shortcut, { timeout: kActionTimeout });
      }
      if (action.name === 'check')
        await frame.check(noCallMetadata, action.selector, { timeout: kActionTimeout });
      if (action.name === 'uncheck')
        await frame.uncheck(noCallMetadata, action.selector, { timeout: kActionTimeout });
      if (action.name === 'select')
        await frame.selectOption(noCallMetadata, action.selector, [], action.options.map(value => ({ value })), { timeout: kActionTimeout });
    } catch (e) {
      this._generator.performedActionFailed(actionInContext);
      return;
    }
    const timer = setTimeout(() => {
      actionInContext.committed = true;
      this._timers.delete(timer);
    }, 5000);
    this._generator.didPerformAction(actionInContext);
    this._timers.add(timer);
  }

  private async _recordAction(frame: Frame, action: actions.Action) {
    this._generator.addAction({
      pageAlias: this._pageAliases.get(frame._page)!,
      ...describeFrame(frame),
      action
    });
  }

  private _onFrameNavigated(frame: Frame, page: Page) {
    const pageAlias = this._pageAliases.get(page);
    this._generator.signal(pageAlias!, frame, { name: 'navigation', url: frame.url() });
  }

  private _onPopup(page: Page, popup: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    const popupAlias = this._pageAliases.get(popup)!;
    this._generator.signal(pageAlias, page.mainFrame(), { name: 'popup', popupAlias });
  }
  private _onDownload(page: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    this._generator.signal(pageAlias, page.mainFrame(), { name: 'download' });
  }

  private _onDialog(page: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    this._generator.signal(pageAlias, page.mainFrame(), { name: 'dialog', dialogAlias: String(++this._lastDialogOrdinal) });
  }
}
