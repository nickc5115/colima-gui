import { render } from 'preact';
import { App } from './App';
import '../styles.css';
import '@xterm/xterm/css/xterm.css';

render(<App />, document.getElementById('root')!);
