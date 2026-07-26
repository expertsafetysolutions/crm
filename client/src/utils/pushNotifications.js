// Converts the VAPID public key (base64url) to the Uint8Array shape pushManager.subscribe expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function subscribeToPush(token) {
  if (!isPushSupported() || !token) return;
  try {
    if (Notification.permission === 'denied') return;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const registration = await navigator.serviceWorker.ready;

    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await fetch('/api/staff/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ subscription: existing.toJSON() })
      });
      return;
    }

    const keyRes = await fetch('/api/push/vapid-public-key', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!keyRes.ok) return;
    const { publicKey } = await keyRes.json();
    if (!publicKey) return;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    await fetch('/api/staff/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
  } catch (err) {
    console.error('Push subscription failed:', err);
  }
}

async function unsubscribeFromPush(token) {
  if (!isPushSupported() || !token) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    await fetch('/api/staff/push-unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    }).catch(() => {});

    await subscription.unsubscribe();
  } catch (err) {
    console.error('Push unsubscribe failed:', err);
  }
}

export { isPushSupported, subscribeToPush, unsubscribeFromPush };
