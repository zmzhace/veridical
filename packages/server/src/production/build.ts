declare const __VERIDICAL_BUILD_ID__: string;
// Injected by the reproducible build, not overridable by a deployment variable.
export const BUILD_ID =
  typeof __VERIDICAL_BUILD_ID__ === 'string' ? __VERIDICAL_BUILD_ID__ : 'unbundled-development';
