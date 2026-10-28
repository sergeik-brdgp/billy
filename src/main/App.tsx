// The app: composes the services once (module singleton, see composition.ts) and renders the root.

import { AppRoot } from './AppRoot';
import { getAppServices } from './composition';

export function App() {
  return <AppRoot services={getAppServices()} />;
}
