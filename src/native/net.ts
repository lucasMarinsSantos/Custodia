// Ponte para o módulo nativo CustodiaNet (NetModule.kt)
//  • checkTls: conecta por HTTPS (HttpsURLConnection) e devolve o certificado, o protocolo e o HSTS
//  • networkInfo: tipo de rede atual (Wi-Fi, dados móveis) para o histórico de acessos, sem GPS
// Sem o módulo nativo (Jest, desenvolvimento), usa um substituto que os testes podem trocar.

import { NativeModules } from 'react-native';

const M: any = NativeModules || {};

export interface TlsInfo {
  /** Conseguiu conectar ao servidor (false = sem internet, DNS falhou ou tempo esgotado). */
  reachable: boolean;
  /** Certificado aceito pelo Android (cadeia confiável, dentro da validade e com o nome do host). */
  valid: boolean;
  error?: string;
  host: string;
  issuer?: string;
  subject?: string;
  /** Nomes do certificado (CN e subjectAltName do tipo DNS). */
  certHosts?: string[];
  validFrom?: number;
  validTo?: number;
  /** Protocolo negociado (TLSv1.3, TLSv1.2…). */
  protocol?: string;
  hsts?: boolean;
  hstsMaxAge?: number;
  status?: number;
}

export interface NetworkInfo {
  connected: boolean;
  type: 'wifi' | 'cellular' | 'ethernet' | 'vpn' | 'other' | 'none' | 'unknown';
}

type TlsFallback = (host: string) => Promise<TlsInfo>;

const defaultTls: TlsFallback = async host => ({ reachable: false, valid: false, host, error: 'Verificação de certificado indisponível neste ambiente' });
let tlsFallback: TlsFallback = defaultTls;
let networkFallback: NetworkInfo = { connected: true, type: 'unknown' };

/** Apenas para testes: simula a resposta da checagem TLS e da rede. */
export function __setNetMocks(opts: { tls?: TlsFallback | null; network?: NetworkInfo | null }) {
  if (opts.tls !== undefined) tlsFallback = opts.tls || defaultTls;
  if (opts.network !== undefined) networkFallback = opts.network || { connected: true, type: 'unknown' };
}

export const Net = {
  get available(): boolean {
    return !!M.CustodiaNet;
  },

  /** Recebe só o host já validado (público, sem porta, sem caminho): a URL completa nunca vai para o nativo. */
  async checkTls(host: string): Promise<TlsInfo> {
    if (M.CustodiaNet) return M.CustodiaNet.checkTls(host);
    return tlsFallback(host);
  },

  async networkInfo(): Promise<NetworkInfo> {
    if (M.CustodiaNet) return M.CustodiaNet.networkInfo();
    return networkFallback;
  },
};
