import React, { Component } from 'react';
import StellarSdk from 'stellar-sdk';
import Nav from './Components/Nav';
import Description from './Components/Description';
import Container from './Components/Container';
import assets from './Assets/Assets';
var toml = require('toml');
var concat = require('concat-stream');
var fs = require('fs');
const DBServer = '20.56.32.165:3602';


class App extends Component {
	constructor() {
		super();
		this.appName = 'PageB';
		this.onInputChangeUpdateField = this.onInputChangeUpdateField.bind(this);
		this.assets = assets;
		this.USD = new StellarSdk.Asset(this.assets[0].code, this.assets[0].issuer);
		// this.GBP = new StellarSdk.Asset(this.assets[1].code,this.assets[1].issuer);
		// this.EUR = new StellarSdk.Asset(this.assets[2].code,this.assets[2].issuer);

		this.state = {

			network: 'Private Testnet',
			account: null,
			balance: 0,
			name: '',
			// Bearer token from /login. Every call below carries it; without one
			// the server answers 401. Kept in component state rather than
			// localStorage so it doesn't outlive the tab.
			token: null,
			loginerror: null,


			fields: {
				friendlyid: null,
				password: null,
				receiver: null,
				amount: null,
				sellprice: null,
				sellamount: null,
			}
		}
	}

	// Every authenticated call sends the token. The server takes the account
	// from it -- the request body no longer names an account, because naming one
	// used to be all it took to read or spend someone else's.
	authHeaders = () => {
		return {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Authorization': 'Bearer ' + this.state.token,
		};
	}

	login = () => {

		var account = this.state.fields.friendlyid;
		var password = this.state.fields.password;
		let app = this;

		if (!account || !password) {
			this.setState({ loginerror: 'Friendly ID and password are required' });
			return;
		}

		var url = 'http://' + DBServer + '/login';

		fetch(url, {
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				friendlyid: account,
				password: password
			})
		}).then(function (response) {
			return response.json().then(function (data) {
				return { ok: response.ok, data: data };
			});
		}).then(function (result) {
			if (!result.ok || !result.data.token) {
				app.setState({ loginerror: 'Login failed', token: null, account: null });
				return;
			}
			app.setState({ token: result.data.token, loginerror: null }, function () {
				app.setAccount(account);
			});
		}).catch(function (error) {
			console.log(error);
			app.setState({ loginerror: 'Could not reach the bank server' });
		});
	}

	setAccount = (account) => {

		let app = this;
		var url = 'http://' + DBServer + '/userdet';

		fetch(url, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({})
		}).then(function (response) {
			if (!response.ok) {
				app.setState({ loginerror: 'Could not load account', token: null });
				return null;
			}
			return response.json();
		}).then(function (data) {
			if (!data) {
				return;
			}
			app.setState({
				account,
				name: data.name,
				balance: data.balance
			});
		}).catch(function (error) {
			console.log(error);
			app.setState({ loginerror: 'Could not reach the bank server' });
		});
	}

	payment = () => {

		let app = this;
		var receiver = this.state.fields.receiver;
		var amount = Number(this.state.fields.amount);

		// The server rejects these too -- it has to, since it can't trust a
		// browser -- but there's no reason to make a round trip to be told so.
		// A negative amount used to be accepted here and *credited* the sender.
		if (!receiver) {
			this.setState({ txstatus: 'Enter a receiver' });
			return;
		}
		if (!this.state.fields.amount || !isFinite(amount) || amount <= 0) {
			this.setState({ txstatus: 'Enter a positive amount' });
			return;
		}

		var url = 'http://' + DBServer + '/payment';

		fetch(url, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({
				receiver: receiver,
				amount: this.state.fields.amount
			})
		}).then(function (response) {
			return response.json();
		}).then(function (data) {
			console.log(data);
			if (data.msg === "SUCCESS!") {
				console.log("Tx hash", data.result);
				var disObj = JSON.parse(data.result);
				app.setState({
					txstatus: 'Transaction Successful',
					txid: disObj.hash
				});
				app.setBalance();
			}
			else {
				console.log("Error", data);
				app.setState({
					txstatus: data.error_msg ? 'Transaction Failed: ' + data.error_msg
						: 'Transaction Failed',
				});
			}
		}).catch(function (error) {
			console.log(error);
			app.setState({ txstatus: 'Transaction Failed: could not reach the bank server' });
		});
	}


	setBank = () => {

		let app = this;
		var url = 'http://' + DBServer + '/bankuser';

		fetch(url, {
			headers: this.authHeaders()
		}).then(function (response) {
			return response.json();
		}).then(function (data) {

			app.setState({
				receivedtx: data.tx
			});

			console.log(app.state.receivedtx);

		}).catch(function (error) {
			console.log(error);
		});
	}

	setBalance = () => {
		let app = this;
		var url = 'http://' + DBServer + '/userbal';

		fetch(url, {
			method: 'POST',
			headers: this.authHeaders(),
			body: JSON.stringify({})
		}).then(function (response) {
			return response.json();
		}).then(function (data) {

			app.setState({
				balance: data.balance
			});
		}).catch(function (error) {
			console.log(error);
		});
	}



	onInputChangeUpdateField = (name, value) => {
		let fields = this.state.fields;

		fields[name] = value;

		this.setState({
			fields
		});
	};

	componentDidMount() {

		this.server = new StellarSdk.Server('http://127.0.0.1:8000', { allowHttp: true });
		this.passphrase = 'Standalone Network ; February 2017';


	}





	render() {


		return (
			<div>
				<Nav appName={this.appName} network={this.state.network} />
				<Description name={this.state.name} />
				<Container onInputChangeUpdateField={this.onInputChangeUpdateField}
					account={this.state.account}
					balance={this.state.balance}
					payment={this.payment}
					setBank={this.setBank}
					receivedtx={this.state.receivedtx}
					chkaddr={this.chkaddr}
					setBalance={this.setBalance}
					fields={this.state.fields}
					login={this.login}
					loginerror={this.state.loginerror}
					txstatus={this.state.txstatus}
					txid={this.state.txid} />

			</div>
		)

	}
}
export default App;
