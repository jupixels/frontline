/** Incremental FNV-1a hash over exact number bits, for desync detection. */
export class StateHasher {
  private h = 0x811c9dc5;
  private readonly view = new DataView(new ArrayBuffer(8));

  private byte(b: number): void {
    this.h ^= b;
    this.h = Math.imul(this.h, 0x01000193);
  }

  num(n: number): this {
    this.view.setFloat64(0, n);
    for (let i = 0; i < 8; i++) this.byte(this.view.getUint8(i));
    return this;
  }

  str(s: string): this {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c & 0xff);
      this.byte(c >>> 8);
    }
    return this;
  }

  digest(): number {
    return this.h >>> 0;
  }
}
