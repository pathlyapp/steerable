import { stripVTControlCharacters } from 'node:util';

import type { Terminal } from '@earendil-works/pi-tui';

export interface TerminalOperation {
  name: string;
  value?: string | number | boolean;
}

export class TestTerminal implements Terminal {
  readonly operations: TerminalOperation[] = [];
  readonly writes: string[] = [];
  kittyProtocolActive = false;

  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private started = false;
  private _columns: number;
  private _rows: number;

  constructor(columns = 100, rows = 30) {
    this._columns = columns;
    this._rows = rows;
  }

  get columns(): number {
    return this._columns;
  }

  get rows(): number {
    return this._rows;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    if (this.started) throw new Error('TestTerminal was started twice');
    this.started = true;
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.operations.push({ name: 'start' });
  }

  stop(): void {
    this.operations.push({ name: 'stop' });
    this.started = false;
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    this.operations.push({
      name: 'drainInput',
      value: `${maxMs ?? 'default'}/${idleMs ?? 'default'}`,
    });
  }

  write(data: string): void {
    this.writes.push(data);
    this.operations.push({ name: 'write', value: data });
  }

  moveBy(lines: number): void {
    this.operations.push({ name: 'moveBy', value: lines });
  }

  hideCursor(): void {
    this.operations.push({ name: 'hideCursor' });
  }

  showCursor(): void {
    this.operations.push({ name: 'showCursor' });
  }

  clearLine(): void {
    this.operations.push({ name: 'clearLine' });
  }

  clearFromCursor(): void {
    this.operations.push({ name: 'clearFromCursor' });
  }

  clearScreen(): void {
    this.operations.push({ name: 'clearScreen' });
  }

  setTitle(title: string): void {
    this.operations.push({ name: 'setTitle', value: title });
  }

  setProgress(active: boolean): void {
    this.operations.push({ name: 'setProgress', value: active });
  }

  input(data: string): void {
    if (!this.inputHandler) throw new Error('TestTerminal is not accepting input');
    this.operations.push({ name: 'input', value: data });
    this.inputHandler(data);
  }

  resize(columns: number, rows: number): void {
    this._columns = columns;
    this._rows = rows;
    this.operations.push({ name: 'resize', value: `${columns}x${rows}` });
    this.resizeHandler?.();
  }

  output(): string {
    return this.writes.join('');
  }

  plainOutput(): string {
    return stripVTControlCharacters(this.output()).replace(/\r/g, '');
  }

  operationNames(): string[] {
    return this.operations.map((operation) => operation.name);
  }
}
