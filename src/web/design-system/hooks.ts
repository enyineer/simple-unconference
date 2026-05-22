// Public hooks barrel for the design system. Kept separate from
// `./index.tsx` (which is the component barrel) so neither file mixes
// component and non-component exports — that mix would trip the
// react-refresh/only-export-components rule and break Fast Refresh
// boundaries.

export { useToast } from "./core/use-toast";
