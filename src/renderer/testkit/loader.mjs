/**
 * 把裸的 'three' 指到上面那个替身。node --import ./testkit/loader.mjs 使用。
 * 只拦这一个 specifier,别的一律照常解析。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(new URL('./resolve-hook.mjs', import.meta.url), pathToFileURL('./'));
