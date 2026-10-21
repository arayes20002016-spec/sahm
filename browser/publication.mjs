const publisherFields = ['name', 'privacyUrl', 'supportUrl', 'homepageUrl'];

export function normalizePublisher(value) {
  if (!value || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', ...publisherFields].includes(key))) throw new Error('Invalid extension publisher configuration');
  const result = {};
  for (const field of publisherFields) {
    const input = value[field];
    if (input === null) { result[field] = null; continue; }
    if (typeof input !== 'string' || !input.trim() || input !== input.trim() || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Invalid publisher field: ' + field);
    if (field === 'name') {
      if (input.length > 120) throw new Error('Publisher name is too long');
    } else {
      const url = new URL(input);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /^(localhost|127\.|0\.|\[)/i.test(url.hostname)) throw new Error('Publisher URLs must be public HTTPS pages');
    }
    result[field] = input;
  }
  return Object.freeze(result);
}

export function publicationStatus(stores, publisher) {
  const missingPublisherFields = publisherFields.filter(field => !publisher[field]);
  return {
    selectedFreeStore: 'edge',
    publisher: { ...publisher },
    missingPublisherFields,
    submissionMetadataComplete: missingPublisherFields.length === 0,
    livePagesVerified: false,
    submittedToStore: false,
    storeInstallationTested: false,
    browsers: {
      edge: { configured: !!stores.edge, url: stores.edge?.url || null, registrationFeeRequired: false, reviewRequired: true },
      chrome: { configured: !!stores.chrome, url: stores.chrome?.url || null, registrationFeeRequired: true, youtubePolicyReviewRequired: true },
    },
  };
}
