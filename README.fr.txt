Scrypted transforme les caméras de votre serveur Scrypted en appareils Homey.
Chacune arrive avec un instantané sur sa tuile et un flux live que vous ouvrez
chez vous comme à l'extérieur, et ce que son détecteur reconnaît devient des
capacités Homey et des déclencheurs de Flow : une personne devant la porte peut
lancer un Flow là où une voiture qui passe ne le fera pas. Le déclencheur porte
l'image qui l'a provoqué, si bien que la notification arrive avec la photo déjà
jointe. Les sonnettes apparaissent comme des sonnettes, avec leur propre
déclencheur et leur instantané.

Il vous faut un serveur Scrypted sur votre réseau local et un Homey Pro : Homey
Cloud et Homey Bridge n'atteignent pas les appareils de votre réseau, donc pas
Scrypted non plus. Ouvrez les réglages de l'app, saisissez l'adresse de votre
serveur et votre compte Scrypted, puis ajoutez vos caméras. Un jeton de connexion
issu de « npx scrypted login » remplace votre mot de passe et se révoque
séparément. Pour le flux live, activez le plugin Rebroadcast de Scrypted sur les
caméras que vous voulez diffuser.
