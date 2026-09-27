import type { ReactElement } from 'react';
import { useCallback } from 'react';
import composeImage from '../../composeImage';
import useCall from '../../hooks/useCall';
import useCanvasContextRef from '../../hooks/useCanvasContextRef';
import useHistory from '../../hooks/useHistory';
import useStore from '../../hooks/useStore';
import ScreenshotsButton from '../../ScreenshotsButton';

export default function Attach(): ReactElement {
  const { image, width, height, history, bounds, lang } = useStore();
  const canvasContextRef = useCanvasContextRef();
  const [, historyDispatcher] = useHistory();
  const call = useCall();
  const onClick = useCallback(() => {
    historyDispatcher.clearSelect();
    setTimeout(() => {
      if (!canvasContextRef.current || !image || !bounds) return;
      composeImage({ image, width, height, history, bounds })
        .then((blob) => call('onAttach', blob, bounds))
        .catch((error: unknown) => call('onError', error));
    });
  }, [canvasContextRef, historyDispatcher, image, width, height, history, bounds, call]);
  return <ScreenshotsButton title={lang.operation_attach_title} icon="icon-attach" onClick={onClick} />;
}
