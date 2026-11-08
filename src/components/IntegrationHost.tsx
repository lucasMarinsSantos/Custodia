// Camada global das integrações, montada com o cofre aberto:
//  • abre a tela de escolha quando chega um pedido de preenchimento de outro app (balão do Custódia);
//  • mostra a confirmação "Permitir"/"Negar" dos pedidos da extensão de navegador.
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Sheet } from './ui';
import { Colors, Type } from '../theme';
import { AUTOFILL_REQUEST_EVENT, AutofillService } from '../services/AutofillService';
import { APPROVAL_EVENT, Approval, BRIDGE_EVENT, BridgeApprovals } from '../services/BrowserBridgeService';
import { bus, toast } from '../services/events';
import { navigateWhenReady } from '../navigation/navigationRef';

/** Tenta navegar algumas vezes: logo após o desbloqueio a pilha de telas ainda está montando. */
function openRequestScreen(attempt = 0) {
  if (!AutofillService.currentRequest) return;
  if (navigateWhenReady('AutofillRequest')) return;
  if (attempt < 10) setTimeout(() => openRequestScreen(attempt + 1), 200);
}

export function IntegrationHost() {
  const [approvals, setApprovals] = useState<Approval[]>(() => BridgeApprovals.pending());

  useEffect(() => {
    openRequestScreen();
    const offRequest = bus.on(AUTOFILL_REQUEST_EVENT, () => openRequestScreen());
    const offApproval = bus.on(APPROVAL_EVENT, () => setApprovals(BridgeApprovals.pending()));
    const offBridge = bus.on(BRIDGE_EVENT, (p?: { pairFailed?: string }) => {
      if (p?.pairFailed) toast(p.pairFailed, 'error');
    });
    return () => {
      offRequest();
      offApproval();
      offBridge();
    };
  }, []);

  const current = approvals[0];
  if (!current) return null;
  return (
    <Sheet visible onClose={() => BridgeApprovals.answer(current.id, false)} title={current.title}>
      <Text style={[Type.body, styles.message]}>{current.message}</Text>
      {current.code ? (
        <Text style={styles.code} accessibilityLabel={`Código ${current.code.replace(/\s/g, '').split('').join(' ')}`}>
          {current.code}
        </Text>
      ) : null}
      {current.kind === 'password' ? <Text style={[Type.small, styles.message]}>A senha vai cifrada só para esta extensão e só desta vez.</Text> : null}
      <View style={styles.row}>
        <Button title="Negar" variant="outline" style={styles.flex} onPress={() => BridgeApprovals.answer(current.id, false)} />
        <Button title="Permitir" icon="check" style={styles.flex} onPress={() => BridgeApprovals.answer(current.id, true)} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  message: { marginBottom: 12 },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  flex: { flex: 1 },
  code: { fontSize: 40, fontWeight: '800', letterSpacing: 6, color: Colors.primary, textAlign: 'center', marginVertical: 12, fontVariant: ['tabular-nums'] },
});
