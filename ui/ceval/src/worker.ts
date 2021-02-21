import { sync, Sync } from 'common/sync';
import { ProtocolOpts, Work } from './types';
import Protocol from './stockfishProtocol';

export function officialStockfish(variant: VariantKey): boolean {
  return variant === 'standard' || variant === 'chess960';
}

export abstract class AbstractWorker<T> {
  protected protocol: Sync<Protocol>;

  constructor(protected protocolOpts: ProtocolOpts, protected opts: T) {
    this.protocol = sync(this.boot());
  }

  stop(): Promise<void> {
    return this.protocol.promise.then(protocol => protocol.stop());
  }

  start(work: Work): Promise<void> {
    return this.protocol.promise.then(protocol => protocol.start(work));
  }

  isComputing: () => boolean = () => !!this.protocol.sync && this.protocol.sync.isComputing();

  engineName: () => string | undefined = () => this.protocol.sync?.engineName.sync;

  protected abstract boot(): Promise<Protocol>;
  protected abstract send(cmd: string): void;
  abstract destroy(): void;
}

export interface WebWorkerOpts {
  url: string;
}

export class WebWorker extends AbstractWorker<WebWorkerOpts> {
  private worker: Worker;

  boot(): Promise<Protocol> {
    this.worker = new Worker(lichess.assetUrl(this.opts.url, { sameDomain: true }));
    const protocol = new Protocol(this.send.bind(this), this.protocolOpts);
    this.worker.addEventListener(
      'message',
      e => {
        protocol.received(e.data);
      },
      true
    );
    protocol.init();
    return Promise.resolve(protocol);
  }

  destroy() {
    this.worker.terminate();
  }

  protected send(cmd: string) {
    this.worker.postMessage(cmd);
  }
}

export interface ThreadedWasmWorkerOpts {
  baseUrl: string;
  module: 'Stockfish' | 'StockfishMv';
}

export class ThreadedWasmWorker extends AbstractWorker<ThreadedWasmWorkerOpts> {
  private static protocols: { Stockfish?: Promise<Protocol>; StockfishMv?: Promise<Protocol> } = {};
  private static sf: { Stockfish?: any; StockfishMv?: any } = {};

  boot(): Promise<Protocol> {
    ThreadedWasmWorker.protocols[this.opts.module] ||= lichess
      .loadScript(this.opts.baseUrl + 'stockfish.js')
      .then(_ =>
        window[this.opts.module]({
          locateFile: (path: string) => {
            return lichess.assetUrl(this.opts.baseUrl + path, {
              sameDomain: path.endsWith('.worker.js'),
            });
          },
        })
      )
      .then((sf: any) => {
        ThreadedWasmWorker.sf[this.opts.module] = sf;
        const protocol = new Protocol(this.send.bind(this), this.protocolOpts);
        sf.addMessageListener(protocol.received.bind(protocol));
        protocol.init();
        return protocol;
      });
    return ThreadedWasmWorker.protocols[this.opts.module]!;
  }

  destroy() {
    // Terminated instances to not get freed reliably
    // (https://github.com/ornicar/lila/issues/7334). So instead of
    // destroying, just stop instances and keep them around for reuse.
    this.protocol.sync?.stop();
  }

  send(cmd: string) {
    ThreadedWasmWorker.sf[this.opts.module]?.postMessage(cmd);
  }
}
