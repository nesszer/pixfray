// Number.isInteger is true only for numbers, so a port can narrow untrusted input with it and add no typeof check.
// The guard names a branded number: a false result rules out integers, not every number, so the false branch keeps
// `number` (1.5 is a number). The brand exists only in types and is assignable to `number`. A value already typed
// `number` takes the first overload and stays plain `number`, which lint rules such as no-unsafe-unary-minus expect.
export {};

declare const integerBrand: unique symbol;

declare global {
  interface NumberConstructor {
    isInteger(value: number): boolean;
    isInteger(value: unknown): value is number & { readonly [integerBrand]: true };
  }
}
