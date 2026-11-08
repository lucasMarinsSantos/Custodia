// Referência global da navegação: permite que serviços (pedido de preenchimento vindo de outro app, pedido da
// extensão de navegador) abram uma tela sem depender de um componente de tela montado.
import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef<any>();

/** Navega quando a navegação já está pronta; devolve false se ainda não estiver (ex.: cofre abrindo). */
export function navigateWhenReady(name: string, params?: object): boolean {
  if (!navigationRef.isReady()) return false;
  navigationRef.navigate(name, params);
  return true;
}
