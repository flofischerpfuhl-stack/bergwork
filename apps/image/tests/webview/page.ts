import { startMatrixPage } from './matrix';

const root = document.getElementById('root');
if (!root) throw new Error('Missing measurement root');
void startMatrixPage(root);
