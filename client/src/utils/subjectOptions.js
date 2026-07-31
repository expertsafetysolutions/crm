/**
 * Add / rename / delete for the Subject-line suggestion list.
 *
 * Lives here rather than in a page because every document builder — quotation, PI, invoice,
 * purchase order — offers the same list and must edit it the same way. Two copies would drift.
 *
 * Each call returns the server's new `subject_options` array so the caller can drop it straight
 * into its settings state; the list updates without re-fetching the whole settings blob.
 *
 * Throws on failure with the server's message, so the caller can surface it through its own flash
 * banner instead of this module deciding how an error should look.
 */

async function send(url, method, headers, body) {
  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not update the subject list');
  return data.subject_options || [];
}

export const createSubjectOption = (headers, text) =>
  send('/api/subject-options', 'POST', headers, { text });

export const renameSubjectOption = (headers, id, text) =>
  send(`/api/subject-options/${id}`, 'PUT', headers, { text });

export const deleteSubjectOption = (headers, id) =>
  send(`/api/subject-options/${id}`, 'DELETE', headers);
