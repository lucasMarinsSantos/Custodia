// Arrastar o usuário ou a senha para outro app em tela dividida
// Toque longo no campo do detalhe da credencial → `View.startDragAndDrop` com `DRAG_FLAG_GLOBAL`; a senha vai
// marcada com `ClipDescription.EXTRA_IS_SENSITIVE` (o sistema não mostra prévia do conteúdo).
// Regras: cofre aberto, app em multi-janela, pasta sem `blockAutofill` (arrastar é preencher outro app) e, se a
// pasta exigir, confirmação de identidade. Arrastar a senha conta como uso da credencial.

import { Drag } from '../native/integration';
import { Credential } from '../types/models';
import { confirmIdentity } from './AutofillService';
import { PolicyService } from './PolicyService';
import { Repo } from './Repository';
import { Vault } from './VaultService';

export type DragField = 'username' | 'password';

export const DRAG_MSG = {
  locked: 'Cofre bloqueado. Desbloqueie para arrastar.',
  notMultiWindow: 'Para arrastar, abra o Custódia em tela dividida com o outro app e solte no campo de login dele.',
  blocked: 'A pasta desta credencial não permite levar a senha para outros apps. Copie manualmente.',
  empty: 'Este campo está vazio.',
  failed: 'Não foi possível iniciar o arrastar. Tente de novo segurando o campo.',
};

export class DragError extends Error {}

export const DragService = {
  async isInMultiWindow(): Promise<boolean> {
    return Drag.isInMultiWindow().catch(() => false);
  },

  /** Inicia o arrastar. Lança `DragError` com a mensagem para o usuário quando não pode. */
  async start(cred: Credential, field: DragField): Promise<void> {
    if (!Vault.isUnlocked) throw new DragError(DRAG_MSG.locked);
    const value = field === 'password' ? cred.password : cred.username;
    if (!value) throw new DragError(DRAG_MSG.empty);
    const policy = PolicyService.forCredential(await Repo.folders(), cred);
    if (policy.blockAutofill) throw new DragError(DRAG_MSG.blocked);
    if (!(await this.isInMultiWindow())) throw new DragError(DRAG_MSG.notMultiWindow);
    if (field === 'password' && policy.requireReauth) await confirmIdentity();
    if (!Vault.isUnlocked) throw new DragError(DRAG_MSG.locked);
    const label = `${cred.title} — ${field === 'password' ? 'senha' : 'usuário'}`;
    const result = await Drag.startDrag(value, label, field === 'password');
    if (!result.multiWindow) throw new DragError(DRAG_MSG.notMultiWindow);
    if (!result.started) throw new DragError(DRAG_MSG.failed);
    if (field === 'password') await Repo.recordUsage(cred.id);
  },
};
