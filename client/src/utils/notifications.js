export const requestNotificationPermission = async () => {
  if (!('Notification' in window)) {
    console.warn('This browser does not support desktop notification');
    return false;
  }

  if (Notification.permission === 'granted') {
    return true;
  }

  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }

  return false;
};

export const sendNotification = (title, options = {}) => {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  if (document.hidden) {
    const notification = new Notification(title, {
      icon: '/logo.png', // Assuming we have a logo in public/
      ...options
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }
};
