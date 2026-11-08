// Aviso do teste de dicionário, usado no gerador e no cadastro de credenciais
// A verificação é local (DictionaryService): a senha não sai do aparelho.
import React, { useMemo } from 'react';
import { DictionaryService } from '../services/DictionaryService';
import { Banner } from './ui';

export const DICTIONARY_WARNING_TITLE = 'Senha de dicionário';

export function DictionaryWarning({ password }: { password: string }) {
  const hit = useMemo(() => DictionaryService.check(password), [password]);
  if (!hit.found) return null;
  return <Banner tone="warning" icon="book-open" title={DICTIONARY_WARNING_TITLE} text={`${hit.reason}. Ataques de dicionário testam esta senha primeiro: use o gerador.`} />;
}
