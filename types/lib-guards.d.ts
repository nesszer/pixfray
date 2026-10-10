// Number.isInteger is true only for numbers, so a port can narrow untrusted input with it and add no typeof check.
// A value already typed number takes the first overload: a guard would make the false branch (1.5) `never`.
interface NumberConstructor {
  isInteger(value: number): boolean;
  isInteger(value: unknown): value is number;
}
