// Espera a verificação de integridade do desbloqueio (AppController → IntegrityService.checkAfterUnlock)
// antes de gravar no banco. Gravar antes mudaria o digest do conteúdo e geraria um falso alerta de adulteração
// (e, ao contrário, poderia mascarar uma adulteração real). Sem o AppController (testes), libera após o prazo.
import { bus, Events } from './events';

export const INTEGRITY_WAIT_MS = 4000;

let gate: Promise<void> = Promise.resolve();

function arm(timeoutMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const off = bus.on(Events.INTEGRITY_CHECKED, done);
  });
}

// Registrado no carregamento do módulo, antes dos ouvintes de UNLOCKED dos serviços que dependem dele
bus.on(Events.UNLOCKED, () => {
  gate = arm(INTEGRITY_WAIT_MS);
});

/** Resolve quando a verificação de integridade do último desbloqueio terminou (ou o prazo acabou). */
export function afterIntegrityCheck(): Promise<void> {
  return gate;
}
