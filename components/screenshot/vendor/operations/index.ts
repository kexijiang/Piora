import Arrow from './Arrow';
import Attach from './Attach';
import Brush from './Brush';
import Cancel from './Cancel';
import Ellipse from './Ellipse';
import Mosaic from './Mosaic';
import Ok from './Ok';
import Rectangle from './Rectangle';
import Redo from './Redo';
import Save from './Save';
import Text from './Text';
import Undo from './Undo';

const operationButtons = [
  Rectangle,
  Ellipse,
  Arrow,
  Brush,
  Text,
  Mosaic,
  '|',
  Undo,
  Redo,
  '|',
  Save,
  Attach,
  Cancel,
  Ok,
];

export default operationButtons;
