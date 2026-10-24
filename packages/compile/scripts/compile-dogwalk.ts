/** Compiles examples/dogwalk from the recorded answers. */
import { join } from 'node:path';
import { compile } from '../src/index.ts';
import { dogwalkModel } from '../test/dogwalk-answers.ts';

const root = join(import.meta.dirname, '../../../examples/dogwalk');
const result = await compile(root, { model: dogwalkModel() });
console.log(JSON.stringify(result, null, 2));
