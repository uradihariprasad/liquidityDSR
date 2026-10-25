export interface PanelProps {
  symbol: string;
  tf: number;
  setSymbol: (s: string) => void;
  setTf: (n: number) => void;
  bundle: any;
  bundleLoading: boolean;
  bundleError: string | null;
}
