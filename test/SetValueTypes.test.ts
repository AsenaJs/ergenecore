import { describe, expect, it } from 'bun:test';
import { ErgenecoreContextWrapper } from '../lib';

declare module '@asenajs/asena/adapter' {
  interface AsenaVariables {
    setValueUser: { id: string; name: string };
    setValueCount: number;
  }
}

// The @ts-expect-error lines are the assertions: `bun run typecheck` fails if any of them compiles.
describe('setValue typing with augmented AsenaVariables', () => {
  const createContext = () => new ErgenecoreContextWrapper(new Request('http://localhost/'));

  it('accepts the declared type for an augmented key', () => {
    const ctx = createContext();

    ctx.setValue('setValueUser', { id: '1', name: 'Ada' });
    ctx.setValue('setValueCount', 42);

    expect(ctx.getValue('setValueUser').name).toBe('Ada');
    expect(ctx.getValue('setValueCount')).toBe(42);
  });

  it('rejects a wrong value for an augmented key', () => {
    const ctx = createContext();

    // @ts-expect-error - number is not { id: string; name: string }
    ctx.setValue('setValueUser', 42);
    // @ts-expect-error - name is required
    ctx.setValue('setValueUser', { id: '1' });
    // @ts-expect-error - string is not number
    ctx.setValue('setValueCount', '42');
  });

  it('rejects a wrong value for the built-in authSession key', () => {
    const ctx = createContext();

    // @ts-expect-error - authSession is AuthSession | null | undefined
    ctx.setValue('authSession', 'token');
  });

  it('still accepts any value for an undeclared key', () => {
    const ctx = createContext();

    ctx.setValue('anythingElse', { free: 'form' });

    expect(ctx.getValue<{ free: string }>('anythingElse').free).toBe('form');
  });
});
