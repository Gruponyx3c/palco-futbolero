# Palco Futbolero

Sala para ver el partido con amigos: el anfitrión comparte la pestaña del partido, todos se escuchan por micrófono y ven el mismo chat, reacciones y marcador en vivo.

## Qué hay en esta carpeta

```
palco-futbolero/
├── index.html        La sala (crear y entrar)
├── ayuda.html        Página "Cómo funciona"
├── 404.html          Si alguien abre un link mal escrito, lo manda a la sala
├── README.md         Este archivo
├── css/
│   ├── estilos.css   Colores, letras y piezas compartidas
│   ├── sala.css      Diseño de la sala
│   └── ayuda.css     Diseño de la guía
├── js/
│   ├── sala.js       Toda la lógica: conexión, voz, chat, marcador y seguridad
│   └── peerjs.min.js (opcional) Copia local de la librería de conexión
└── img/
    └── logo.svg      Ícono de la pestaña y logo
```

No borres ni cambies de nombre ningún archivo ni carpeta: las páginas se buscan entre sí por esos nombres.

## Publicarla en GitHub Pages

1. Entra a github.com e inicia sesión (o crea tu cuenta con **Sign up**).
2. Arriba a la derecha: **+** → **New repository**.
3. Nombre: `palco-futbolero`. Deja **Public**. No marques ninguna casilla. **Create repository**.
4. Presiona el link **uploading an existing file**.
5. Abre esta carpeta en tu computadora, selecciona **todo lo que hay adentro** (los archivos y las carpetas `css`, `js` e `img`) y arrástralo al recuadro.
   - Arrastra el contenido, no la carpeta `palco-futbolero` entera. `index.html` tiene que quedar en la raíz del repositorio, no dentro de otra carpeta.
6. Espera a que aparezcan todos los archivos y presiona **Commit changes**.
7. Ve a **Settings** → **Pages**. En **Branch** elige **main** y **/ (root)**. Presiona **Save**.
8. Espera 1 o 2 minutos y recarga. Tu link aparece arriba:
   `https://TU-USUARIO.github.io/palco-futbolero/`

## Actualizar

En el repositorio: **Add file** → **Upload files**, arrastra los archivos nuevos (con el mismo nombre) y **Commit changes**. El link no cambia.

## Seguridad

- **Sala de espera:** nadie entra sin que el anfitrión lo acepte. Mientras espera no ve, no escucha y no puede escribir.
- **Cerrar la sala:** cuando ya llegaron todos, nadie más puede pedir entrar.
- **Silenciar y sacar:** el anfitrión controla quién habla y puede expulsar a cualquiera.
- **Solo el anfitrión comparte pantalla**, y solo se aceptan voces de personas aceptadas.
- **Anti-spam:** máximo 6 mensajes o reacciones cada 10 segundos por persona, y 8 invitados como máximo.
- **El texto nunca se ejecuta:** nombres y mensajes se muestran como texto plano.
- **Política de seguridad (CSP):** las páginas solo pueden cargar código de esta carpeta, de unpkg (PeerJS) y letras de Google Fonts, y solo pueden conectarse al servidor de PeerJS.
- **No se guardan datos:** lo único que queda es tu nombre, en tu propio navegador.

### Opcional: no depender de unpkg

1. Abre https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js en el navegador.
2. Guarda la página (Ctrl + S) con el nombre `peerjs.min.js` dentro de la carpeta `js/`.
3. Súbelo a GitHub junto con lo demás.

Con ese archivo en su lugar, la sala usa tu copia. Si no está, usa la de unpkg automáticamente.

## Cómo funciona por dentro

- La conexión es directa entre navegadores (WebRTC), usando PeerJS y su servidor público gratuito solo para que los equipos se encuentren.
- El video y las voces no pasan por GitHub ni se graban.
- La sala existe mientras el anfitrión tenga la pestaña abierta.
